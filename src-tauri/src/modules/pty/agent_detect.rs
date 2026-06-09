use std::sync::atomic::{AtomicU8, Ordering};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

const OSC_MAX: usize = 2048;

const DEFAULT_AGENTS: &[&str] = &["claude", "codex"];

// OSC 777 marker our Claude Code hooks emit via `terminalSequence`.
const TERAX_MARKER: &[u8] = b"notify;Terax;";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Working,
    Waiting,
    Finished,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Transition {
    Started { agent: String },
    Working,
    Attention,
    Finished,
    Exited,
}

const INPUT_INACTIVE: u8 = 0;
const INPUT_CODEX_WORKING: u8 = 1;
const INPUT_CODEX_IDLE: u8 = 2;

pub(super) struct AgentInputState {
    state: AtomicU8,
}

impl AgentInputState {
    pub(super) fn new() -> Self {
        Self {
            state: AtomicU8::new(INPUT_INACTIVE),
        }
    }

    pub(super) fn observe(&self, transition: &Transition) {
        match transition {
            Transition::Started { agent } => {
                let next = if agent == "codex" {
                    INPUT_CODEX_WORKING
                } else {
                    INPUT_INACTIVE
                };
                self.state.store(next, Ordering::Release);
            }
            Transition::Working => {
                if self.state.load(Ordering::Acquire) != INPUT_INACTIVE {
                    self.state.store(INPUT_CODEX_WORKING, Ordering::Release);
                }
            }
            Transition::Attention | Transition::Finished => {
                if self.state.load(Ordering::Acquire) != INPUT_INACTIVE {
                    self.state.store(INPUT_CODEX_IDLE, Ordering::Release);
                }
            }
            Transition::Exited => self.state.store(INPUT_INACTIVE, Ordering::Release),
        }
    }

    pub(super) fn mark_working_from_input(&self, input: &[u8]) -> bool {
        if !input.contains(&b'\r') || input.starts_with(b"\x1b[200~") {
            return false;
        }
        self.state
            .compare_exchange(
                INPUT_CODEX_IDLE,
                INPUT_CODEX_WORKING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
}

impl Transition {
    pub fn into_signal(self, id: u32) -> AgentSignal {
        match self {
            Transition::Started { agent } => AgentSignal {
                id,
                kind: "started",
                agent: Some(agent),
            },
            Transition::Working => AgentSignal {
                id,
                kind: "working",
                agent: None,
            },
            Transition::Attention => AgentSignal {
                id,
                kind: "attention",
                agent: None,
            },
            Transition::Finished => AgentSignal {
                id,
                kind: "finished",
                agent: None,
            },
            Transition::Exited => AgentSignal {
                id,
                kind: "exited",
                agent: None,
            },
        }
    }
}

pub struct AgentDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    armed: bool,
    agent: Option<String>,
    status: Status,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self::with_agents(DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect())
    }

    pub fn with_agents(agents: Vec<String>) -> Self {
        Self {
            agents,
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
            agent: None,
            status: Status::Working,
        }
    }

    /// Feed a chunk of raw PTY output. Transitions come only from OSC sequences
    /// (`133` prompt boundaries, our `777` hook marker), never from raw output,
    /// so a TUI agent that repaints continuously never flaps working/waiting.
    pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], mut emit: F) {
        if self.state == State::Ground && !input.contains(&ESC) {
            return;
        }

        for &b in input {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI doesn't leave a stale entry if the shell died mid-command.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.disarm();
            emit(Transition::Exited);
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.agent = None;
        self.status = Status::Working;
    }

    fn finish_osc<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, emit),
            // OSC 9;4 is taskbar progress, not a notification.
            b"9" if !pt.starts_with(b"4;") && pt != b"4" => self.handle_osc9(pt, emit),
            b"777" => self.handle_osc777(pt, emit),
            _ => {}
        }
    }

    pub(super) fn sync_input_state(&mut self, input_state: &AgentInputState) {
        if self.agent.as_deref() == Some("codex")
            && input_state.state.load(Ordering::Acquire) == INPUT_CODEX_WORKING
        {
            self.status = Status::Working;
        }
    }

    fn handle_osc9<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if self.agent.as_deref() == Some("codex") {
            if codex_notification_needs_attention(pt) {
                self.generic_attention(emit);
            } else {
                self.set_finished(emit);
            }
            return;
        }
        self.generic_attention(emit);
    }

    fn handle_osc777<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if let Some(event) = pt.strip_prefix(TERAX_MARKER) {
            // Self-arms so notifications work even when no shell preexec fired
            // (bash, Windows, tmux, wrappers).
            match event {
                b"working" => {
                    self.ensure_armed(emit);
                    self.set_working(emit);
                }
                b"attention" => {
                    self.ensure_armed(emit);
                    self.status = Status::Waiting;
                    emit(Transition::Attention);
                }
                b"finished" => {
                    self.ensure_armed(emit);
                    self.set_finished(emit);
                }
                _ => {}
            }
            return;
        }
        self.generic_attention(emit);
    }

    fn handle_osc133<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                if let Some(agent) = self.match_agent(cmd) {
                    self.armed = true;
                    self.agent = Some(agent.clone());
                    self.status = Status::Working;
                    emit(Transition::Started { agent });
                }
            }
            Some(b'D') if self.armed => {
                self.disarm();
                emit(Transition::Exited);
            }
            _ => {}
        }
    }

    fn ensure_armed<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if !self.armed {
            self.armed = true;
            self.agent = Some("claude".into());
            self.status = Status::Working;
            emit(Transition::Started {
                agent: "claude".into(),
            });
        }
    }

    fn set_working<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.status != Status::Working {
            self.status = Status::Working;
            emit(Transition::Working);
        }
    }

    fn set_finished<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.armed && self.status != Status::Finished {
            self.status = Status::Finished;
            emit(Transition::Finished);
        }
    }

    fn generic_attention<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.armed {
            self.status = Status::Waiting;
            emit(Transition::Attention);
        }
    }

    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        let tokens = command_tokens(cmd);
        let mut command_idx = tokens.iter().position(|token| !is_env_assignment(token))?;
        for _ in 0..4 {
            if let Some(agent) = self.agent_for_executable(&tokens[command_idx]) {
                return Some(agent);
            }

            let launcher = executable_base(&tokens[command_idx]).to_ascii_lowercase();
            command_idx = match launcher.as_str() {
                "npx" | "bunx" | "pnpx" | "command" | "exec" | "&" | "call" => {
                    next_non_option(&tokens, command_idx + 1)
                }
                "env" => next_env_command(&tokens, command_idx + 1),
                "npm" | "pnpm" | "yarn" | "bun" => {
                    let subcommand_idx = next_non_option(&tokens, command_idx + 1)?;
                    let subcommand = tokens[subcommand_idx].to_ascii_lowercase();
                    if matches!(subcommand.as_str(), "exec" | "x" | "dlx") {
                        next_non_option(&tokens, subcommand_idx + 1)
                    } else {
                        None
                    }
                }
                _ => None,
            }?;
        }
        None
    }

    fn agent_for_executable(&self, token: &str) -> Option<String> {
        let base = executable_base(token);
        self.agents
            .iter()
            .find(|agent| agent_name_matches(base, agent))
            .cloned()
    }
}

fn command_tokens(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in cmd.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn next_non_option(tokens: &[String], start: usize) -> Option<usize> {
    (start..tokens.len()).find(|&idx| !tokens[idx].starts_with('-'))
}

fn next_env_command(tokens: &[String], start: usize) -> Option<usize> {
    (start..tokens.len())
        .find(|&idx| !tokens[idx].starts_with('-') && !is_env_assignment(&tokens[idx]))
}

fn is_env_assignment(token: &str) -> bool {
    token
        .split_once('=')
        .is_some_and(|(name, _)| !name.is_empty() && !name.contains(['/', '\\']))
}

fn executable_base(token: &str) -> &str {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
    strip_windows_command_extension(base)
}

fn strip_windows_command_extension(base: &str) -> &str {
    const EXTS: [&str; 5] = [".exe", ".cmd", ".bat", ".com", ".ps1"];
    for ext in EXTS {
        if base.len() > ext.len() && base.to_ascii_lowercase().ends_with(ext) {
            return &base[..base.len() - ext.len()];
        }
    }
    base
}

fn agent_name_matches(base: &str, agent: &str) -> bool {
    let base = base.to_ascii_lowercase();
    let agent = agent.to_ascii_lowercase();
    base.strip_prefix(agent.as_str())
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
}

fn codex_notification_needs_attention(message: &[u8]) -> bool {
    [
        b"Approval requested:".as_slice(),
        b"Approval requested by ".as_slice(),
        b"Codex wants to edit ".as_slice(),
        b"Plan mode prompt:".as_slice(),
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut AgentDetector, input: &[u8]) -> Vec<Transition> {
        let mut out = Vec::new();
        d.process(input, |t| out.push(t));
        out
    }

    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![ESC, OSC_INTRO];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[ESC, ST_FINAL]);
        v
    }

    fn started(agent: &str) -> Transition {
        Transition::Started {
            agent: agent.into(),
        }
    }

    #[test]
    fn arms_on_agent_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude -p hello")),
            vec![started("claude")]
        );
    }

    #[test]
    fn arms_on_pathed_and_wrapped_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;/usr/local/bin/codex exec")),
            vec![started("codex")]
        );
        let mut d2 = AgentDetector::new();
        assert_eq!(
            run(&mut d2, &osc("133;C;npx claude")),
            vec![started("claude")]
        );
        let mut d3 = AgentDetector::new();
        assert_eq!(
            run(&mut d3, &osc(r#"133;C;"/Applications/Codex Tools/codex""#)),
            vec![started("codex")]
        );
        let mut d4 = AgentDetector::new();
        assert_eq!(
            run(&mut d4, &osc("133;C;env TERAX=1 pnpm exec codex")),
            vec![started("codex")]
        );
        let mut d5 = AgentDetector::new();
        assert_eq!(run(&mut d5, &osc("133;C;& codex")), vec![started("codex")]);
    }

    #[test]
    fn arms_on_windows_command_shims() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(
                &mut d,
                &osc(r"133;C;C:\Users\op237\AppData\Roaming\npm\codex.cmd exec")
            ),
            vec![started("codex")]
        );
        let mut d2 = AgentDetector::new();
        assert_eq!(
            run(&mut d2, &osc("133;C;claude.exe --continue")),
            vec![started("claude")]
        );
    }

    #[test]
    fn arms_on_dash_suffixed_alias() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude-enigma")),
            vec![started("claude")]
        );
    }

    #[test]
    fn does_not_arm_on_other_commands() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
        assert!(run(&mut d, &osc("133;C;cat claude.txt")).is_empty());
        assert!(run(&mut d, &osc("133;C;claudexyz")).is_empty());
    }

    #[test]
    fn does_not_arm_when_agent_name_is_only_an_argument() {
        for command in [
            "echo codex",
            "where codex",
            "which claude",
            "cat codex",
            "rg claude src",
        ] {
            let mut d = AgentDetector::new();
            assert!(
                run(&mut d, &osc(&format!("133;C;{command}"))).is_empty(),
                "incorrectly armed for {command}"
            );
        }
    }

    #[test]
    fn ignores_bell_and_plain_output() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert!(run(&mut d, &[BEL]).is_empty());
        assert!(run(&mut d, b"thinking...\x07more").is_empty());
    }

    #[test]
    fn terax_marker_drives_status() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;attention")),
            vec![Transition::Attention]
        );
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;working")),
            vec![Transition::Working]
        );
        assert!(run(&mut d, &osc("777;notify;Terax;working")).is_empty());
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;finished")),
            vec![Transition::Finished]
        );
    }

    #[test]
    fn terax_marker_auto_arms_without_preexec() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;attention")),
            vec![started("claude"), Transition::Attention]
        );
    }

    #[test]
    fn generic_notifications_only_emit_when_armed() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(
            run(&mut d, &osc("777;notify;Codex;ready")),
            vec![Transition::Attention]
        );
        assert_eq!(
            run(&mut d, &osc("9;Approval requested: run tests")),
            vec![Transition::Attention]
        );
        assert!(run(&mut d, &osc("9;4;1;50")).is_empty());
    }

    #[test]
    fn codex_osc9_distinguishes_completion_from_attention() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(
            run(&mut d, &osc("9;Approval requested: run tests")),
            vec![Transition::Attention]
        );
        assert_eq!(
            run(&mut d, &osc("9;Implemented and verified the fix")),
            vec![Transition::Finished]
        );
    }

    #[test]
    fn codex_input_state_resumes_without_locking_the_output_detector() {
        let state = AgentInputState::new();
        state.observe(&started("codex"));
        state.observe(&Transition::Finished);

        assert!(!state.mark_working_from_input(b"next task"));
        assert!(!state.mark_working_from_input(b"\x1b[200~first\rsecond\x1b[201~"));
        assert!(state.mark_working_from_input(b"\r"));
        assert!(!state.mark_working_from_input(b"\r"));

        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;codex"));
        run(&mut d, &osc("9;first turn complete"));
        d.sync_input_state(&state);
        assert_eq!(
            run(&mut d, &osc("9;second turn complete")),
            vec![Transition::Finished]
        );
    }

    #[test]
    fn exits_on_133d() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("133;D;0")), vec![Transition::Exited]);
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn bel_terminator_inside_osc_is_not_attention() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend_from_slice(b"0;set title");
        seq.push(BEL);
        assert!(run(&mut d, &seq).is_empty());
    }

    #[test]
    fn started_split_across_chunks() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &[ESC, OSC_INTRO]).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[ESC, ST_FINAL]));
        assert_eq!(out, vec![started("claude")]);
    }

    #[test]
    fn finish_reports_exited_when_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert_eq!(out, vec![Transition::Exited]);
        let mut out2 = Vec::new();
        d.finish(|t| out2.push(t));
        assert!(out2.is_empty());
    }

    #[test]
    fn oversized_osc_does_not_panic() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend(std::iter::repeat_n(b'x', OSC_MAX + 100));
        seq.extend_from_slice(&[ESC, ST_FINAL]);
        assert!(run(&mut d, &seq).is_empty());
        assert_eq!(
            run(&mut d, &osc("777;notify;Terax;attention")),
            vec![Transition::Attention]
        );
    }
}
