# Security

jev-save is an efficiency guard, not a security sandbox. It sends a projection of each tool call (tool name, a bounded preview of the arguments, cwd, a short ledger of recent actions and the user's recent words) to Jev over TLS and turns the answers into allow / retry / ask / deny decisions. Jev is a probabilistic model that reads untrusted text; treat its answers as advice with a measured error rate, never as a boundary. Keep your host's own permission controls.

It fails **open** by default: an unreachable API, a missing key, a timeout or a malformed answer lets the tool call proceed and writes one line to the decision log. Set `JEV_SAVE_FAIL_CLOSED=1` if you prefer the opposite.

The security questions inherited from jev-guard (destructive-command risk, approval, instructions planted in untrusted content) are kept and run in the same Jev call. See jev-guard's own security notes for their limits.

Report a vulnerability privately through GitHub security advisories on this repository rather than a public issue.
