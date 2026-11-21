// imsg-reader-config: the only way to change what the reader may read. Writes need root (sudo),
// so no agent or script running as you can widen its own access.
import Foundation

let out = FileHandle.standardOutput
func say(_ s: String) { print(s) }
func die(_ s: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((s + "\n").utf8))
    exit(code)
}

struct Account { let name: String; let home: String; let uid: uid_t }

/// The account the reader serves: the sudo caller, or the current user without sudo.
func account() -> Account {
    let name = ProcessInfo.processInfo.environment["SUDO_USER"].flatMap { $0.isEmpty ? nil : $0 }
    let pw = name.flatMap { getpwnam($0) } ?? getpwuid(getuid())
    guard let pw else { die("can't look up the user account") }
    return Account(name: String(cString: pw.pointee.pw_name), home: String(cString: pw.pointee.pw_dir), uid: pw.pointee.pw_uid)
}

func requireRoot() {
    if geteuid() != 0 { die("This changes the reader's access, so it needs sudo:\n  sudo \(CommandLine.arguments[0]) \(CommandLine.arguments.dropFirst().joined(separator: " "))") }
}

func loadConfig() -> ReaderConfig {
    guard let d = FileManager.default.contents(atPath: Consts.configPath) else {
        die("No config at \(Consts.configPath). Run install.sh first.")
    }
    do { return try decodeConfig(d) } catch { die("config.json: \(error)") }
}

func saveConfig(_ c: ReaderConfig) {
    requireRoot()
    do {
        try validateConfig(c)
        let data = try encodeConfig(c)
        let tmp = Consts.configDir + "/.config.json.tmp"
        unlink(tmp)
        guard FileManager.default.createFile(atPath: tmp, contents: data, attributes: [.posixPermissions: 0o644, .ownerAccountID: 0, .groupOwnerAccountID: 0]) else {
            die("can't write \(tmp)")
        }
        guard rename(tmp, Consts.configPath) == 0 else { die("can't replace config.json: \(String(cString: strerror(errno)))") }
    } catch {
        die("Not saved: \(error)")
    }
    say("Saved \(Consts.configPath). The reader picks it up on its next run (within 5 minutes), or run: sudo \(CommandLine.arguments[0]) run-now")
}

func ask(_ q: String, default d: String? = nil) -> String {
    print(q + (d.map { " [\($0)]" } ?? "") + ": ", terminator: "")
    let a = (readLine() ?? "").trimmingCharacters(in: .whitespaces)
    return a.isEmpty ? (d ?? "") : a
}

func stateDir(_ a: Account) -> String { a.home + "/" + Consts.stateRel }

func run(_ path: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    do { try p.run() } catch { die("can't run \(path): \(error)") }
    p.waitUntilExit()
    return p.terminationStatus
}

let args = Array(CommandLine.arguments.dropFirst())
let cmd = args.first ?? "help"

switch cmd {
case "init":
    // Used by install.sh: creates an empty config for this account if none exists.
    requireRoot()
    if FileManager.default.fileExists(atPath: Consts.configPath) { say("Config already exists; left as is."); exit(0) }
    let a = account()
    saveConfig(ReaderConfig(version: 1, user: a.name, threads: [:], agents: [:], setup: true, retain_days: 30))

case "status":
    let c = loadConfig()
    say("Account: \(c.user ?? "(any)")    setup: \(c.setup == true ? "ON (chat list is being written)" : "off")")
    say("Threads:")
    if c.threads.isEmpty { say("  (none)") }
    for (alias, t) in c.threads.sorted(by: { $0.key < $1.key }) {
        let who = c.agents.filter { $0.value.threads.contains(alias) }.keys.sorted()
        say("  \(alias): \(t.guids.count) chat id(s), \(t.senders?.count ?? 0) named members, hold \(t.hold) min, read by \(who.isEmpty ? "nobody" : who.joined(separator: ", "))")
    }
    say("Agents:")
    for (agent, ag) in c.agents.sorted(by: { $0.key < $1.key }) { say("  \(agent): \(ag.threads.isEmpty ? "(no threads)" : ag.threads.joined(separator: ", "))") }
    let hp = stateDir(account()) + "/health.json"
    if let d = FileManager.default.contents(atPath: hp), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
        say("Last run: \(j["run_finished"] ?? "?")  ok: \(j["ok"] ?? "?")  sandboxed: \(j["sandboxed"] ?? "?")")
        if let e = j["error"] as? String { say("  error: \(e)") }
        if let ts = j["threads"] as? [String: [String: Any]] {
            for (k, v) in ts.sorted(by: { $0.key < $1.key }) {
                say("  \(k): ok \(v["ok"] ?? "?"), members \(v["members"] ?? "?"), records \(v["records"] ?? 0), held \(v["held"] ?? 0)\((v["error"] as? String).map { ", error: \($0)" } ?? "")")
            }
        }
    } else {
        say("Last run: none yet")
    }

case "setup":
    guard args.count == 2, ["on", "off"].contains(args[1]) else { die("usage: sudo imsg-reader-config setup on|off") }
    var c = loadConfig()
    c.setup = args[1] == "on"
    saveConfig(c)
    if c.setup == true { say("After the next run, pick a chat with: sudo \(CommandLine.arguments[0]) add-thread") }

case "add-thread":
    requireRoot()
    var c = loadConfig()
    let path = stateDir(account()) + "/setup/chats.json"
    guard let d = FileManager.default.contents(atPath: path),
          let listing = try? JSONDecoder().decode(SetupListingFile.self, from: d) else {
        die("No chat list yet. Turn setup on (sudo \(CommandLine.arguments[0]) setup on), wait for a run or use run-now, then try again.")
    }
    say("Chats, most recent first (listed \(listing.generated_at)):")
    // The list sits in the user's folder, so treat it as untrusted: strip control characters before printing.
    for raw in listing.chats {
        let ch = SetupChatFile(n: raw.n, guid: raw.guid, name: cleanText(raw.name, maxChars: 60, flatten: true).text, kind: cleanText(raw.kind, maxChars: 10).text,
                               service: cleanText(raw.service, maxChars: 20).text, members: raw.members.map { cleanText($0, maxChars: 80, flatten: true).text },
                               last_active: raw.last_active.map { cleanText($0, maxChars: 30).text })
        let label = ch.name.isEmpty ? "(no name) " + ch.members.prefix(3).joined(separator: ", ") + (ch.members.count > 3 ? ", ..." : "") : ch.name
        say(String(format: "%3d  %@  [%@, %d members, %@, last %@]", ch.n, label, ch.kind, ch.members.count, ch.service, String((ch.last_active ?? "?").prefix(10))))
    }
    let picks = ask("Chat number(s) for this thread, comma-separated (an iMessage and an SMS copy of one chat can both go in)")
        .split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    let chosen = listing.chats.filter { picks.contains($0.n) }
    guard !chosen.isEmpty, chosen.count == picks.count else { die("No valid chat numbers picked; nothing saved.") }
    let alias = ask("Short name for the thread (lowercase letters, digits, dashes), e.g. team-chat")
    guard isValidName(alias) else { die("'\(alias)' isn't a valid name; nothing saved.") }
    guard c.threads[alias] == nil else { die("A thread named \(alias) already exists; nothing saved.") }
    var senders: [String: String] = [:]
    let members = Array(Set(chosen.flatMap { $0.members }.map { cleanText($0, maxChars: 200, flatten: true).text }.filter { !$0.isEmpty })).sorted()
    say("Name the members you want agents to see by name. Press Enter to leave one as \"Unknown member\".")
    for m in members {
        let n = ask("  \(m)")
        if !n.isEmpty { senders[m] = n }
    }
    let agentList = ask("Agents that may read it, comma-separated", default: "main")
        .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let hold = Int(ask("Minutes to hold each message before summarizing (covers unsends and edits)", default: "15")) ?? 15
    let shownName = chosen.map { $0.name }.first { !$0.isEmpty } ?? ""
    c.threads[alias] = ThreadConfig(guids: chosen.map { $0.guid }, senders: senders.isEmpty ? nil : senders, hold_minutes: hold,
                                    backfill_days: 2, expect_name: shownName, expect_members: members)
    for ag in agentList {
        var a = c.agents[ag] ?? AgentConfig(threads: [])
        if !a.threads.contains(alias) { a.threads.append(alias) }
        c.agents[ag] = a
    }
    say("\nThread \(alias): \(chosen.map { $0.name.isEmpty ? "(no name)" : $0.name }.joined(separator: " + ")), \(senders.count) of \(members.count) members named, read by \(agentList.joined(separator: ", ")).")
    guard ask("Save? y/N").lowercased() == "y" else { die("Not saved.", 0) }
    saveConfig(c)
    say("Setup is still on. When you're done adding threads: sudo \(CommandLine.arguments[0]) setup off")
    say("The reader checks this chat's name and members against chat.db on every run and refuses the thread if they don't match.")

case "name":
    guard args.count == 4 else { die("usage: sudo imsg-reader-config name THREAD HANDLE NAME   (NAME \"-\" clears it)") }
    var c = loadConfig()
    guard var t = c.threads[args[1]] else { die("No thread \(args[1]).") }
    var s = t.senders ?? [:]
    s[args[2]] = args[3] == "-" ? nil : args[3]
    t.senders = s.isEmpty ? nil : s
    c.threads[args[1]] = t
    saveConfig(c)

case "grant", "revoke":
    guard args.count == 3 else { die("usage: sudo imsg-reader-config \(cmd) AGENT THREAD") }
    var c = loadConfig()
    guard c.threads[args[2]] != nil else { die("No thread \(args[2]).") }
    var a = c.agents[args[1]] ?? AgentConfig(threads: [])
    if cmd == "grant" {
        if !a.threads.contains(args[2]) { a.threads.append(args[2]) }
    } else {
        a.threads.removeAll { $0 == args[2] }
    }
    c.agents[args[1]] = a
    saveConfig(c)

case "remove-thread":
    guard args.count == 2 else { die("usage: sudo imsg-reader-config remove-thread THREAD") }
    var c = loadConfig()
    guard c.threads[args[1]] != nil else { die("No thread \(args[1]).") }
    c.threads[args[1]] = nil
    for k in c.agents.keys { c.agents[k]!.threads.removeAll { $0 == args[1] } }
    saveConfig(c)

case "remove-agent":
    guard args.count == 2 else { die("usage: sudo imsg-reader-config remove-agent AGENT") }
    var c = loadConfig()
    guard c.agents[args[1]] != nil else { die("No agent \(args[1]).") }
    c.agents[args[1]] = nil
    saveConfig(c)
    say("Its outbox is deleted on the next run.")

case "verify":
    // The unified log can't be edited or deleted by programs running as you, so the reader's own lines
    // are always there. It is not proof of who wrote a line: the path it shows comes from the binary's
    // build ID, so treat any line that disagrees with the rest as a red flag.
    say("The reader's log for the last 2 hours. \"resolve\" lines name the chat each thread read, straight from chat.db:")
    _ = run("/usr/bin/log", ["show", "--last", "2h", "--style", "compact", "--predicate", "subsystem == \"com.nanoclaw.imsg-reader\""])

case "run-now":
    let a = account()
    let rc = run("/bin/launchctl", ["kickstart", "gui/\(a.uid)/\(Consts.label)"])
    if rc == 0 { say("Started. Check in a minute with: \(CommandLine.arguments[0]) status") }
    exit(rc)

default:
    say("""
    imsg-reader-config: change what the iMessage reader may read. Changes need sudo.

      status                    threads, agents and the last run
      setup on|off              write a chat list (names and member numbers, no message text) for add-thread
      add-thread                pick a chat from that list, name it and its members, choose agents
      name THREAD HANDLE NAME   name a member (NAME "-" clears it)
      grant AGENT THREAD        let an agent read a thread
      revoke AGENT THREAD       stop an agent reading a thread
      remove-thread THREAD      stop reading a thread at all
      remove-agent AGENT        remove an agent; its outbox is deleted on the next run
      verify                    the reader's log: which chat each thread read, and any errors
      run-now                   start a run now
    """)
}

struct SetupChatFile: Decodable {
    let n: Int
    let guid: String
    let name: String
    let kind: String
    let service: String
    let members: [String]
    let last_active: String?
}

struct SetupListingFile: Decodable {
    let generated_at: String
    let chats: [SetupChatFile]
}
