#!/usr/bin/env bash
#
# ssh-door — the box-side dispatcher that turns `ssh <deployment> new|list|attach ...`
# into the sandbox door verbs, while leaving every other ssh use untouched.
#
# STAGED ONLY. This script ships in the repo but is NOT wired by the branch
# that adds it: wiring is an authorized_keys `command="..."` entry on a
# DEDICATED operator key (or an sshd Match block) — deploy-coupled box state,
# operator-gated. See docs/sandbox/RUNBOOK-door.md. Never wrap the existing
# CI key or the operator's primary key: a buggy wrapper on those locks out
# the deploy lane and the box itself.
#
# Behavior:
#   ssh box new [...]     -> ncl sandboxes new [...]
#   ssh box list [...]    -> ncl sandboxes list [...]
#   ssh box attach <name> -> ncl sandboxes attach <name>
#   ssh box               -> login shell (interactive use unchanged)
#   sftp subsystem        -> sftp-server (sshd hands a subsystem request to a
#                            forced command as SSH_ORIGINAL_COMMAND="sftp";
#                            modern scp (OpenSSH >= 9.0) rides SFTP by default)
#   ssh box <anything>    -> $SHELL -c "<anything>"  (transparent fall-through:
#                            classic scp -O, CI, debug one-liners keep working)
#
# The door arms MUST run from the host tree: the ncl client dials
# data/ncl.sock relative to process.cwd() (src/config.ts PROJECT_ROOT =
# process.cwd()), and sshd runs command= with cwd=$HOME — without the cd the
# client would look for ~/data/ncl.sock and fail. The fall-through arms must
# NOT cd, preserving scp/CI path semantics.

set -u

# Where the deployed host tree lives (contains dist/cli/client.js and
# data/ncl.sock). REQUIRED, with no default: the install root is per
# deployment (`~/recipe-spike-k8s/host` on the POC, `~/nanoco-k8s-runc/host`
# on the runc box, whatever an operator chose elsewhere), and a default that
# names one of them turns "you did not wire NCL_HOST_ROOT" into "the tree is
# missing at a path this box never used". The wiring that installs this script
# is the authorized_keys `command=` entry, which is the same place the value
# belongs.
HOST_ROOT="${NCL_HOST_ROOT:-}"

cmd="${SSH_ORIGINAL_COMMAND:-}"

# No command: an interactive `ssh box` — hand over a login shell, unchanged.
if [ -z "$cmd" ]; then
  exec "${SHELL:-/bin/sh}" -l
fi

case "$cmd" in
  new | new\ * | list | list\ * | attach | attach\ *)
    if [ -z "$HOST_ROOT" ]; then
      echo "ssh-door: NCL_HOST_ROOT is not set — point it at this deployment's host tree" >&2
      exit 1
    fi
    # Pod route: on a pod-placed host the node-side ncl socket cannot answer
    # (a hostPath unix socket does not cross the Kata VM boundary), so the
    # wire's command= entry names the host workload and the verb execs inside
    # it. NCL_DOOR_POD is "<namespace>:<kubectl workload ref>".
    if [ -n "${NCL_DOOR_POD:-}" ]; then
      door_ns="${NCL_DOOR_POD%%:*}"
      door_workload="${NCL_DOOR_POD#*:}"
      tty_flags="-i"
      [ -t 0 ] && [ -t 1 ] && tty_flags="-it"
      door_args=""
      set -f
      # shellcheck disable=SC2086
      for door_word in $cmd; do
        door_args="$door_args $(printf '%q' "$door_word")"
      done
      exec sudo -n k3s kubectl -n "$door_ns" exec $tty_flags "$door_workload" -- \
        /bin/sh -c "cd $(printf '%q' "$HOST_ROOT") && exec ./bin/ncl sandboxes$door_args"
    fi
    cd "$HOST_ROOT" || {
      echo "ssh-door: host tree not found at $HOST_ROOT (NCL_HOST_ROOT)" >&2
      exit 1
    }
    # Word-split the door command into argv on purpose; no glob expansion.
    set -f
    # shellcheck disable=SC2086
    exec node dist/cli/client.js sandboxes $cmd
    ;;
  sftp)
    # An SFTP *subsystem* request (sshd(8): with command= in force, the
    # subsystem name arrives as SSH_ORIGINAL_COMMAND). $SHELL -c "sftp"
    # would exec the interactive sftp CLIENT and die on usage — exec the
    # real server. Modern scp defaults to SFTP mode, so plain `scp` over
    # the door key lands here.
    for sftp_server in \
      /usr/lib/openssh/sftp-server \
      /usr/libexec/openssh/sftp-server \
      /usr/libexec/sftp-server \
      /usr/lib/ssh/sftp-server; do
      [ -x "$sftp_server" ] && exec "$sftp_server"
    done
    echo "ssh-door: no sftp-server binary found; use classic-protocol scp -O" >&2
    exit 1
    ;;
  *)
    # Transparent fall-through: whatever ssh was asked to run, run it —
    # from $HOME, exactly as a bare sshd would. (Classic-protocol `scp -O`
    # arrives here as a remote 'scp -t ...' command and works unchanged.)
    exec "${SHELL:-/bin/sh}" -c "$cmd"
    ;;
esac
