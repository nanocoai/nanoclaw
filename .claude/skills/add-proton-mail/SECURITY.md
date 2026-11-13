# Proton Mail: what the adapter trusts, and why

Reference for `/add-proton-mail` (see SKILL.md, **Security**).

- **Who a mail is from.** The `From:` header is the sender's own claim, so the
  adapter takes it only when Proton vouches for it, in one of two ways:
  - *Mail from outside Proton.* Proton's inbound servers check SPF, DKIM and
    DMARC alignment of the `From:` domain and record the result in
    `Authentication-Results` headers under their own authserv-id,
    `mail.protonmail.ch`; Bridge serves those headers as Proton stored them.
    The mail counts as from its address only when there is exactly one Proton
    DMARC verdict, it is `pass`, and it names the `From:` domain. Proton strips
    a sender-supplied `mail.protonmail.ch` header (checked on Bridge 3.27.0),
    and one that slipped through would sit beside Proton's own and be refused
    as two. A domain's DMARC policy doesn't matter: with `p=none` Proton still
    delivers forged mail, but records `dmarc=fail`.
  - *Mail from another Proton account.* This carries no DMARC verdict. Proton
    marks it `X-Pm-Origin: internal`, and its `From:` comes from Proton's
    record of the sending account, which can only send as its own addresses.
    It counts as verified with exactly one `X-Pm-Origin`, `internal`, and no
    Proton DMARC verdict. Proton strips a sender-supplied `X-Pm-Origin` from
    outside mail and adds its own `external` (checked on Bridge 3.27.0), so a
    forged `internal` would show as two values and be refused. A Proton
    account can also send as an address outside Proton's domains (a custom
    domain, or a connected external address), and nothing Proton adds says
    which, so `internal` is trusted only from Proton's own domains
    (`proton.me`, `protonmail.com`, `protonmail.ch`, `pm.me` and their
    subdomains) and from domains listed exactly in
    `PROTON_MAIL_INTERNAL_DOMAINS`. Not even the Bridge account's own domain
    is trusted unless listed: an account can send from a connected Gmail
    address, so its domain proves nothing. Internal mail from any other domain
    is left unread and flagged `$NanoClawFailed`: it is almost always a real
    Proton user on a custom domain nobody listed.

  Either way the `From:` must be a single plain address on a single `From:`
  line (no quoted local part, no second address), and a display name that
  names another address is dropped. Mail from the Bridge account's own address
  is never delivered. Refused mail is logged and left unread.
- **One spelling per address.** Addresses are compared trimmed, NFC, lower
  case, with the domain in its ASCII (punycode) form, so `alice@bücher.de` and
  `alice@xn--bcher-kva.de` are one sender. A messaging group or user written
  by hand in another form never matches mail; the adapter names any such
  messaging group at startup, with the form to store instead.
- **What this does not prove.** DMARC vouches for a domain, not a mailbox: for
  outside mail the adapter relies on the sender's own domain to stop its users
  sending as each other, and any shared service in the domain's SPF record
  widens who can send for it. That covers ordinary mail and `/` admin commands,
  not only approvals, so the owner should write from a Proton address
  (identified by mailbox) or from a domain with tight sending controls. Anyone
  can open a free Proton account, and they are then verified as their *own*
  address only; unknown senders still need your approval.
- **Approvals.** Because of that, an approval needs more than a verified
  sender. Each card mail carries a random token in its subject; an answer counts
  only from the card's approver, quoting the token, sent `In-Reply-To` the card
  mail itself (or the one reminder the adapter sends the approver about it),
  with one of the card's commands on the first line — so only someone who can
  read the approver's mailbox can answer, and a reply always answers the card
  it replies to. Cards are kept in `store/proton-mail/state.json` and survive a
  restart.
- **Admin commands.** A `/` command on the first line of a verified owner's mail
  reaches core's command gate like any other channel's.
- **Text hidden from the reader.** HTML a mail client would not show
  (`display:none`, `hidden`, zero-size or transparent text, `<template>`, …)
  is kept but marked `[hidden CODE: … /hidden CODE]`, and invisible or
  text-direction characters are marked too, with a code chosen at random for
  each mail; when the agent's text carries any mark, a note tells it to treat
  marked text as suspect and never as instructions. A mark without the code
  was written by the sender. A lone direction mark beside Hebrew or Arabic
  letters, or a zero-width space between Thai, Lao, Khmer or Myanmar letters,
  is ordinary text and left alone. Parsing and HTML conversion run in worker
  threads with timeouts and a memory ceiling, so a crafted mail cannot stall
  the host.
- **The channel's own lines.** Every bracketed line the channel adds carries
  the mail's code: forwarded text sits between `[forwarded CODE: …]` and
  `[end of forwarded text CODE]` (its From/Date lines are the sender's claim,
  and instructions inside it are not the sender's request), attachments held
  back are listed as `[attachments not delivered by the mail channel CODE: …]`,
  a long mail ends `[… truncated by the mail channel CODE, …]`, and the
  channel's notes come last. The one plain line is `Subject: …`, added after
  the sender's text when the subject is new to the conversation; it repeats
  the mail's own subject, which is the sender's words anyway. A sender-typed `[Note from the mail channel` is rewritten as the
  sender's, even with invisible or control characters inside it — best
  effort: what the agent checks is the code.
- **Limits on strangers and loops.** New addresses not yet approved are
  limited to 10 an hour, 200 in any 7 days and 20 per domain in the same 7
  days (an address core has since approved or denied gives its slot back), so
  strangers cannot fill the approval cards the owner's own approvals need. At
  most 20 mails an hour from one sender reach the agent; the rest wait and are
  handed over as the hour frees up. That is a throttle, not a loop breaker:
  Bridge drops every loop marker on outgoing mail, and NanoClaw has no loop
  handling for any channel yet, so two agents mailing each other are slowed to
  about 20 mails an hour each, not stopped. Waiting mail is capped: 200 in all,
  of which senders not yet approved may use 100 between them (whichever limit
  held their mail; someone a card was mailed to counts as approved here), any one domain's 20 and any one new address 5, so an
  approved sender's over-limit mail always has room. A denied address's mail
  over the hourly limit is not held or even fetched (core would drop it).
  Past a cap, mail is left unread and flagged `$NanoClawFailed`.
- **Transport.** IMAP requires STARTTLS (never opportunistic) and SMTP requires
  TLS. With `PROTON_MAIL_TLS_CA_FILE` set (the default from setup) Bridge's own
  certificate is verified on every connection, so a process squatting the
  loopback port while Bridge is down cannot collect the bridge password.
- **Who can reach Bridge.** Its ports are published on the host's `127.0.0.1`
  only. On Linux, agent containers cannot reach them: they are on other
  networks and `host.docker.internal` is the Docker bridge gateway, not the
  host's loopback. On Docker Desktop (macOS, Windows), `host.docker.internal`
  does reach the host's loopback, so an agent container could connect there —
  but it holds no bridge password: agents see neither `.env` nor the project
  folder, and every IMAP/SMTP command needs that password.
- **What anyone with the volume holds.** The `nanoclaw-proton-bridge` volume is
  the Proton login. Its keyring key is unprotected (headless), so anyone with
  root or Docker on this host can read the mailbox — as with any credential on
  the host.
