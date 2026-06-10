use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};

use super::agent_detect::{AgentDetector, AgentInputState};
use super::da_filter::DaFilter;
use super::shell_init;
use crate::modules::workspace::WorkspaceEnv;

pub(super) const AGENT_EVENT: &str = "terax:agent-signal";

// Flusher coalesces a short window after first-byte arrival so we send chunks,
// not single bytes. MAX_IDLE is only a safety net for missed signals.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
const FLUSH_MAX_IDLE: Duration = Duration::from_millis(50);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[terax: dropped output due to backpressure]\x1b[0m\r\n";

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<super::job::PtyJob>,
    /// PID of the shell process. 0 means unknown; callers must skip checks when 0.
    pub shell_pid: u32,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub(super) agent_input_state: Arc<AgentInputState>,
    pub(super) diagnostics: SessionDiagnostics,
    pub(super) echo_watch: EchoWatch,
    /// Last size requested via resize; the echo watchdog restores this after
    /// its unstick jiggle so it never clobbers a user resize.
    pub(super) size: Mutex<(u16, u16)>,
    // PtyMaster::drop acquires CONPTY_LIFECYCLE_LOCK before ClosePseudoConsole.
    pub master: PtyMaster,
}

/// Detects a stalled ConPTY: input was written but the console produced no
/// output. A healthy shell echoes within tens of ms; a corrupted/stalled
/// conhost buffers input silently until a resize kicks it. Armed on each
/// interactive write, cleared by the reader on any output.
pub(super) struct EchoWatch {
    // (armed_at, kicks_fired_for_this_arm)
    pending: Mutex<Option<(Instant, u32)>>,
}

impl EchoWatch {
    fn new() -> Self {
        Self {
            pending: Mutex::new(None),
        }
    }

    pub(super) fn arm(&self, data: &[u8]) {
        if is_terminal_response(data) {
            return;
        }
        let mut g = self.pending.lock().unwrap();
        if g.is_none() {
            *g = Some((Instant::now(), 0));
        }
    }

    fn clear(&self) {
        *self.pending.lock().unwrap() = None;
    }

    /// True when the oldest unanswered input has waited past `threshold`.
    /// Re-arms with a fresh timestamp so kicks repeat up to `max_kicks`.
    #[cfg(windows)]
    fn should_kick(&self, threshold: Duration, max_kicks: u32) -> bool {
        let mut g = self.pending.lock().unwrap();
        match g.as_mut() {
            Some((armed_at, kicks)) if *kicks < max_kicks && armed_at.elapsed() >= threshold => {
                *kicks += 1;
                *armed_at = Instant::now();
                true
            }
            _ => false,
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct SessionDiagnostics {
    started_at: Instant,
    first_input_seen: AtomicBool,
    first_interactive_input_seen: AtomicBool,
    first_output_after_interactive_seen: AtomicBool,
    first_interactive_input_at: Mutex<Option<Instant>>,
}

impl SessionDiagnostics {
    fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            first_input_seen: AtomicBool::new(false),
            first_interactive_input_seen: AtomicBool::new(false),
            first_output_after_interactive_seen: AtomicBool::new(false),
            first_interactive_input_at: Mutex::new(None),
        }
    }

    pub(super) fn mark_first_input(&self) -> Option<Duration> {
        if self.first_input_seen.swap(true, Ordering::AcqRel) {
            None
        } else {
            Some(self.started_at.elapsed())
        }
    }

    pub(super) fn mark_first_interactive_input(&self, data: &[u8]) -> Option<Duration> {
        if is_terminal_response(data)
            || self
                .first_interactive_input_seen
                .swap(true, Ordering::AcqRel)
        {
            None
        } else {
            if let Ok(mut input_at) = self.first_interactive_input_at.lock() {
                *input_at = Some(Instant::now());
            }
            Some(self.started_at.elapsed())
        }
    }

    pub(super) fn mark_first_output_after_interactive_input(&self) -> Option<Duration> {
        let input_at = self
            .first_interactive_input_at
            .lock()
            .ok()
            .and_then(|g| *g)?;
        if self
            .first_output_after_interactive_seen
            .swap(true, Ordering::AcqRel)
        {
            None
        } else {
            Some(input_at.elapsed())
        }
    }
}

fn is_terminal_response(data: &[u8]) -> bool {
    if matches!(data, b"\x1b[I" | b"\x1b[O") {
        return true;
    }
    if data.starts_with(b"\x1b]") {
        return true;
    }
    if data.len() < 4 || !data.starts_with(b"\x1b[") {
        return false;
    }
    let Some((&final_byte, body)) = data.split_last() else {
        return false;
    };
    let params = &body[2..];
    let numeric_params = params
        .iter()
        .all(|b| b.is_ascii_digit() || matches!(b, b';' | b'?' | b'>' | b'='));
    numeric_params && matches!(final_byte, b'R' | b'c' | b'n')
}

pub(super) fn drop_session(session: Arc<Session>) {
    // CONPTY_LIFECYCLE_LOCK is acquired inside PtyMaster::drop.
    drop(session);
}


/// Wraps the PTY master and serializes Windows ConPTY lifecycle around Drop.
///
/// ClosePseudoConsole can block ~60 s while conhost drains. Holding
/// CONPTY_LIFECYCLE_LOCK for that entire duration blocked new terminal spawns,
/// causing a ~60-second input-echo delay. This wrapper narrows the lock to
/// only ClosePseudoConsole itself.
pub(super) struct PtyMaster {
    inner: ManuallyDrop<Mutex<Box<dyn MasterPty + Send>>>,
}

impl PtyMaster {
    pub(super) fn new(master: Box<dyn MasterPty + Send>) -> Self {
        Self { inner: ManuallyDrop::new(Mutex::new(master)) }
    }

    pub(super) fn lock(
        &self,
    ) -> std::sync::LockResult<std::sync::MutexGuard<'_, Box<dyn MasterPty + Send>>> {
        self.inner.lock()
    }
}

impl Drop for PtyMaster {
    fn drop(&mut self) {
        #[cfg(windows)]
        let _guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();
        // SAFETY: this is the only drop of `inner`; `_guard` still alive here.
        unsafe { ManuallyDrop::drop(&mut self.inner) };
    }
}
struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            killer: Some(killer),
        }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<(Arc<Session>, PtySize), String> {
    let spawn_at = Instant::now();
    let pty_system = native_pty_system();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let cmd = shell_init::build_command(cwd, workspace)?;
    // Hold the lock across BOTH CreatePseudoConsole and the CreateProcess that
    // attaches the shell to it. Letting an attach overlap another console's
    // create/close corrupts the new console: conhost buffers I/O but pumps
    // nothing until a later resize kicks it (issue #356 — narrowing this to
    // openpty alone reintroduced the "one terminal frozen at startup" stall).
    // Shell startup (profile load etc.) happens after attach, outside the lock.
    let (pair, mut child) = {
        #[cfg(windows)]
        let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();
        let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        (pair, child)
    };
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    guard.disarm();

    let shell_pid = child.process_id().unwrap_or(0);

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match super::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        shell_pid,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        agent_input_state: Arc::new(AgentInputState::new()),
        diagnostics: SessionDiagnostics::new(spawn_at),
        echo_watch: EchoWatch::new(),
        size: Mutex::new((cols, rows)),
        master: PtyMaster::new(pair.master),
    });
    let agent_input_state = session.agent_input_state.clone();
    let session_for_diagnostics = session.clone();

    let pending: Arc<(Mutex<Vec<u8>>, Condvar)> =
        Arc::new((Mutex::new(Vec::with_capacity(READ_BUF)), Condvar::new()));
    let done = Arc::new(AtomicBool::new(false));

    let pending_r = pending.clone();
    let writer_for_da = writer.clone();
    let app_reader = app.clone();
    let reader_thread = thread::Builder::new()
        .name("terax-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detector = AgentDetector::new();
            let mut dropped_bytes: u64 = 0;
            let mut logged_first = false;
            let mut logged_first_da = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        session_for_diagnostics.echo_watch.clear();
                        if !logged_first {
                            logged_first = true;
                            log::info!(
                                "pty first output id={id} after {}ms",
                                spawn_at.elapsed().as_millis()
                            );
                        }
                        agent_detector.sync_input_state(&agent_input_state);
                        agent_detector.process(&buf[..n], |t| {
                            agent_input_state.observe(&t);
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            let response_started = Instant::now();
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                            let elapsed = response_started.elapsed();
                            if !logged_first_da {
                                logged_first_da = true;
                                log::info!(
                                    "pty first DA response id={id} completed in {}ms",
                                    elapsed.as_millis()
                                );
                            } else if elapsed >= Duration::from_millis(100) {
                                log::warn!(
                                    "pty DA response id={id} blocked for {}ms",
                                    elapsed.as_millis()
                                );
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        if let Some(elapsed) =
                            session_for_diagnostics
                                .diagnostics
                                .mark_first_output_after_interactive_input()
                        {
                            log::info!(
                                "pty first output after interactive input id={id} after {}ms bytes={}",
                                elapsed.as_millis(),
                                filtered.len()
                            );
                        }
                        let (lock, cv) = &*pending_r;
                        let mut g = lock.lock().unwrap();
                        if g.len() + filtered.len() > MAX_PENDING {
                            dropped_bytes += g.len() as u64;
                            g.clear();
                            g.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.extend_from_slice(&filtered);
                        cv.notify_one();
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detector.finish(|t| {
                agent_input_state.observe(&t);
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
            pending_r.1.notify_one();
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .expect("spawn pty reader thread");

    let on_data_flush = on_data.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    thread::Builder::new()
        .name("terax-pty-flusher".into())
        .spawn(move || {
            let (lock, cv) = &*pending_f;
            let mut flush_seq: u64 = 0;
            let mut last_flush_log: Option<Instant> = None;
            loop {
                {
                    let mut g = lock.lock().unwrap();
                    while g.is_empty() {
                        if done_f.load(Ordering::Acquire) {
                            return;
                        }
                        let (next, _) = cv.wait_timeout(g, FLUSH_MAX_IDLE).unwrap();
                        g = next;
                    }
                }
                // Coalesce a short window so a burst flushes as one chunk.
                thread::sleep(FLUSH_COALESCE);
                let chunk = std::mem::take(&mut *lock.lock().unwrap());
                if chunk.is_empty() {
                    continue;
                }
                flush_seq += 1;
                let send_started = Instant::now();
                let chunk_len = chunk.len();
                let send_result = on_data_flush.send(Response::new(chunk));
                let send_ms = send_started.elapsed().as_millis();
                let should_log = flush_seq <= 5
                    || chunk_len >= 8192
                    || send_ms >= 100
                    || last_flush_log
                        .map(|last| last.elapsed() >= Duration::from_secs(5))
                        .unwrap_or(true);
                if should_log {
                    last_flush_log = Some(Instant::now());
                    log::info!(
                        "pty output flush id={id} seq={flush_seq} bytes={chunk_len} send_ms={send_ms} since_spawn={}ms",
                        spawn_at.elapsed().as_millis()
                    );
                }
                if let Err(e) = send_result {
                    log::debug!("pty flusher exiting, channel closed: {e}");
                    break;
                }
            }
        })
        .expect("spawn pty flusher thread");

    let on_data_exit = on_data;
    let pending_e = pending;
    let done_e = done.clone();
    thread::Builder::new()
        .name("terax-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Wait for the reader to hit EOF before taking a final snapshot of
            // `pending`, so the last line of output never races the Exit event.
            #[cfg(windows)]
            {
                let deadline = Instant::now() + Duration::from_millis(50);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            let (lock, cv) = &*pending_e;
            let tail = std::mem::take(&mut *lock.lock().unwrap());
            if !tail.is_empty() {
                if let Err(e) = on_data_exit.send(Response::new(tail)) {
                    log::debug!("pty final-data send failed (channel closed): {e}");
                }
            }
            done_e.store(true, Ordering::Release);
            cv.notify_all();
            if let Err(e) = on_exit.send(code) {
                log::debug!("pty exit send failed (channel closed): {e}");
            }
        })
        .expect("spawn pty waiter thread");

    // ConPTY stall recovery: if input goes unanswered, jiggle the console
    // size to force conhost to start pumping. Normal echo round-trips in
    // tens of ms, so a 1.5s silence after a keystroke means conhost stalled.
    #[cfg(windows)]
    {
        const KICK_AFTER: Duration = Duration::from_millis(1500);
        const MAX_KICKS: u32 = 3;
        let weak = std::sync::Arc::downgrade(&session);
        let done_w = done.clone();
        thread::Builder::new()
            .name(format!("terax-pty-echo-watch-{id}"))
            .spawn(move || loop {
                thread::sleep(Duration::from_millis(500));
                if done_w.load(Ordering::Acquire) {
                    return;
                }
                let Some(s) = weak.upgrade() else { return };
                if !s.echo_watch.should_kick(KICK_AFTER, MAX_KICKS) {
                    continue;
                }
                let (c, r) = *s.size.lock().unwrap();
                log::warn!(
                    "pty input unanswered id={id} for {}ms: kicking conpty with resize jiggle ({c}x{r})",
                    KICK_AFTER.as_millis()
                );
                if let Ok(m) = s.master.lock() {
                    let _ = m.resize(PtySize {
                        rows: r + 1,
                        cols: c,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                    let _ = m.resize(PtySize {
                        rows: r,
                        cols: c,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                };
            })
            .expect("spawn pty echo watch thread");
    }

    Ok((session, size))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;

    #[test]
    fn drop_kills_child_process() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 30");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            shell_pid: child.process_id().unwrap_or(0),
            killer: Mutex::new(killer),
            writer,
            agent_input_state: Arc::new(AgentInputState::new()),
            diagnostics: SessionDiagnostics::new(Instant::now()),
            echo_watch: EchoWatch::new(),
            size: Mutex::new((80, 24)),
            master: PtyMaster::new(pair.master),
        });

        assert!(
            child.try_wait().unwrap().is_none(),
            "child must be alive before drop",
        );

        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(exited, "child still running 2s after Session drop");
    }

    #[test]
    fn drop_session_succeeds_after_child_already_exited() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let _ = child.wait();

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            shell_pid: 0,
            killer: Mutex::new(killer),
            writer,
            agent_input_state: Arc::new(AgentInputState::new()),
            diagnostics: SessionDiagnostics::new(Instant::now()),
            echo_watch: EchoWatch::new(),
            size: Mutex::new((80, 24)),
            master: PtyMaster::new(pair.master),
        });

        drop_session(session);
    }
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;

    #[test]
    fn session_diagnostics_marks_only_the_first_input() {
        let diagnostics = SessionDiagnostics::new(Instant::now());

        assert!(diagnostics.mark_first_input().is_some());
        assert!(diagnostics.mark_first_input().is_none());
    }

    #[test]
    fn session_diagnostics_ignores_terminal_responses_for_interactive_input() {
        let diagnostics = SessionDiagnostics::new(Instant::now());

        assert!(diagnostics
            .mark_first_interactive_input(b"\x1b[1;1R")
            .is_none());
        assert!(diagnostics
            .mark_first_interactive_input(b"\x1b[?1;2c")
            .is_none());
        assert!(diagnostics
            .mark_first_interactive_input(b"\x1b[I")
            .is_none());
        assert!(diagnostics.mark_first_interactive_input(b"a").is_some());
        assert!(diagnostics.mark_first_interactive_input(b"\r").is_none());
    }

    #[test]
    fn arrow_keys_count_as_interactive_input() {
        let diagnostics = SessionDiagnostics::new(Instant::now());

        assert!(diagnostics
            .mark_first_interactive_input(b"\x1b[A")
            .is_some());
    }

    #[test]
    fn session_diagnostics_marks_first_output_after_interactive_input_once() {
        let diagnostics = SessionDiagnostics::new(Instant::now());

        assert!(diagnostics
            .mark_first_output_after_interactive_input()
            .is_none());
        assert!(diagnostics.mark_first_interactive_input(b"a").is_some());
        assert!(diagnostics
            .mark_first_output_after_interactive_input()
            .is_some());
        assert!(diagnostics
            .mark_first_output_after_interactive_input()
            .is_none());
    }
}
