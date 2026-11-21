// One run: sandbox, check, read allowlisted threads, summarize on device, write per-agent outboxes.
import Foundation
import os

struct Options {
    var configPath = Consts.configPath
    var dbPath: String
    var home: String
    var stateDir: String
    var now: Date? = nil
    var summarizer = "apple"
    var ownerCheck = true
    var sandbox = true
}

struct Msg {
    let rowid: Int64
    let text: String?
    let body: [UInt8]?
    let handle: String?
    let date: Int64
    let fromMe: Bool
    let itemType: Int64
    let groupAction: Int64
    let otherHandle: String?
    let assocType: Int64
    let hasAttach: Bool
    let edited: Int64
    let retracted: Int64
    let balloon: String?
    let groupTitle: String?
}

struct Pending {
    let id: Int
    let msg: Msg
    let text: String
    let truncated: Bool
    let attach: String
    let corrects: Int64?
}

struct Validated {
    let summary: String
    let kind: String
    let needsAction: Bool
    let deadline: String?
    let facts: [String]
}

enum Outcome {
    case ok(Validated)
    case failed(String)
}

let log = Logger(subsystem: Consts.subsystem, category: "audit")

func runReader(_ o: Options) async -> Int32 {
    umask(0o077)
    let now = o.now ?? Date()
    var health = Health(run_started: iso(Date()))
    do {
        try ensureDir(o.stateDir)
    } catch {
        log.error("can't create state folder: \(String(describing: error), privacy: .public)")
        return 1
    }
    if o.sandbox {
        do {
            try applySandbox(home: o.home, state: o.stateDir)
        } catch {
            health.error = "\(error)"
            try? writeHealth(health, o.stateDir)
            log.error("\(String(describing: error), privacy: .public)")
            return 1
        }
    }
    health.sandboxed = sandboxIsActive(home: o.home)
    guard let lock = acquireLock(o.stateDir) else {
        log.notice("another run is active; exiting")
        return 0
    }
    defer { close(lock) }
    health.last_ok = loadHealth(o.stateDir)?.last_ok
    log.notice("run start v\(Consts.version, privacy: .public) sandboxed=\(health.sandboxed, privacy: .public)")

    do {
        if o.sandbox && !health.sandboxed { throw Failure("the sandbox didn't take effect; refusing to read anything") }
        if o.ownerCheck {
            try checkRootOwned(o.configPath)
            try checkRootOwned((o.configPath as NSString).deletingLastPathComponent)
            guard let exe = ownExecutablePath() else { throw Failure("can't find own executable path") }
            try checkRootOwned(exe)
            try checkRootOwned((exe as NSString).deletingLastPathComponent)
        }
        guard let cdata = FileManager.default.contents(atPath: o.configPath) else {
            throw Failure("config missing or unreadable: \(o.configPath)")
        }
        let cfg = try decodeConfig(cdata)
        if let u = cfg.user, u != userName() {
            log.notice("config is for another account; exiting")
            return 0
        }
        health.setup = cfg.setup ?? false

        let db = try ChatDB(path: o.dbPath)
        let cols = try db.columns("message")
        let required = ["ROWID", "guid", "text", "attributedBody", "handle_id", "date", "is_from_me"]
        let missing = required.filter { !cols.contains($0) }
        guard missing.isEmpty else { throw Failure("chat.db layout changed: message table lacks \(missing.joined(separator: ", ")). Reader needs an update") }
        for t in ["chat", "chat_message_join", "handle"] where try !db.tableExists(t) {
            throw Failure("chat.db layout changed: no \(t) table. Reader needs an update")
        }
        let optional = ["date_edited", "date_retracted", "item_type", "group_action_type", "other_handle",
                        "associated_message_type", "cache_has_attachments", "balloon_bundle_id", "group_title"]
        health.schema_missing_optional = optional.filter { !cols.contains($0) }
        let hasAttachTables = try db.tableExists("attachment") && db.tableExists("message_attachment_join")
        let hasHandleJoin = try db.tableExists("chat_handle_join")

        try db.exec("BEGIN")
        defer { try? db.exec("COMMIT") }

        if cfg.setup == true {
            try writeSetupListing(db, stateDir: o.stateDir, hasHandleJoin: hasHandleJoin, now: now)
        } else {
            try? FileManager.default.removeItem(atPath: o.stateDir + "/setup")
        }
        cleanOutbox(cfg, stateDir: o.stateDir, now: now)

        var state = loadState(o.stateDir, &health, now: now)
        for k in state.threads.keys where cfg.threads[k] == nil { state.threads[k] = nil }

        // Only threads that at least one agent may read are ever opened.
        var readers: [String: [String]] = [:]
        for (agent, a) in cfg.agents { for t in a.threads { readers[t, default: []].append(agent) } }

        if !readers.isEmpty {
            let summarizer = try makeSummarizer(o)
            health.model = "available"
            for alias in readers.keys.sorted() {
                var th = ThreadHealth()
                let run = ThreadRun(alias: alias, cfg: cfg.threads[alias]!, agents: readers[alias]!.sorted(), db: db,
                                    cols: cols, hasAttachTables: hasAttachTables, hasHandleJoin: hasHandleJoin,
                                    summarizer: summarizer, now: now, stateDir: o.stateDir)
                do {
                    try await run.process(state: &state, health: &th)
                    try saveState(state, o.stateDir)
                } catch {
                    th.ok = false
                    th.error = "\(error)"
                    log.error("thread=\(alias, privacy: .public) error: \(String(describing: error), privacy: .public)")
                }
                health.threads[alias] = th
            }
        }
        try saveState(state, o.stateDir)
        health.ok = health.threads.values.allSatisfy { $0.ok }
    } catch {
        health.ok = false
        health.error = "\(error)"
        log.error("run failed: \(String(describing: error), privacy: .public)")
    }
    health.run_finished = iso(Date())
    if health.ok { health.last_ok = health.run_finished }
    try? writeHealth(health, o.stateDir)
    log.notice("run end ok=\(health.ok, privacy: .public)")
    return health.ok ? 0 : 1
}

func makeSummarizer(_ o: Options) throws -> Summarizer {
    #if TESTING
    if o.summarizer == "fake" { return FakeSummarizer(stateDir: o.stateDir) }
    #endif
    return try AppleSummarizer()
}

func writeSetupListing(_ db: ChatDB, stateDir: String, hasHandleJoin: Bool, now: Date) throws {
    let hasMsgDate = try db.columns("chat_message_join").contains("message_date")
    let lastExpr = hasMsgDate
        ? "(SELECT MAX(message_date) FROM chat_message_join WHERE chat_id = c.ROWID)"
        : "(SELECT MAX(m.date) FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id WHERE j.chat_id = c.ROWID)"
    let rows = try db.rows("SELECT c.ROWID, c.guid, c.display_name, c.style, c.service_name, \(lastExpr) AS last FROM chat c ORDER BY last DESC LIMIT 60")
    var chats: [SetupChat] = []
    for (i, r) in rows.enumerated() {
        var members: [String] = []
        if hasHandleJoin {
            members = try db.rows("SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ? ORDER BY h.id",
                                  [.int(r.int(0))]).compactMap { $0.text(0) }.map { cleanText($0, maxChars: 200, flatten: true).text }
        }
        let last = r.int(5)
        chats.append(SetupChat(n: i + 1, guid: cleanText(r.text(1) ?? "", maxChars: 200).text,
                               name: cleanText(r.text(2) ?? "", maxChars: 60, flatten: true).text,
                               kind: r.int(3) == 43 ? "group" : "1:1",
                               service: cleanText(r.text(4) ?? "", maxChars: 20).text,
                               members: members, last_active: last > 0 ? iso(appleDate(last)) : nil))
    }
    let dir = stateDir + "/setup"
    try ensureDir(dir)
    let listing = SetupListing(generated_at: iso(now),
                               note: "Chat list for imsg-reader-config add-thread. Chat names and member numbers only, no message text. Deleted when setup is turned off. Claude doesn't read this file.",
                               chats: chats)
    try atomicWrite(try jsonData(listing), to: dir + "/chats.json")
}

final class ThreadRun {
    let alias: String
    let cfg: ThreadConfig
    let agents: [String]
    let db: ChatDB
    let cols: Set<String>
    let hasAttachTables: Bool
    let hasHandleJoin: Bool
    let summarizer: Summarizer
    let now: Date
    let stateDir: String
    var chatIDs: [Int64] = []
    var ts = ThreadState(cursor: 0, seq: 0, unknown: [:], recent: [:])

    init(alias: String, cfg: ThreadConfig, agents: [String], db: ChatDB, cols: Set<String>, hasAttachTables: Bool,
         hasHandleJoin: Bool, summarizer: Summarizer, now: Date, stateDir: String) {
        self.alias = alias; self.cfg = cfg; self.agents = agents; self.db = db; self.cols = cols
        self.hasAttachTables = hasAttachTables; self.hasHandleJoin = hasHandleJoin
        self.summarizer = summarizer; self.now = now; self.stateDir = stateDir
    }

    // MARK: queries. Every message query is limited to this thread's chats, whatever the state file says.

    private var chatFilter: String {
        "m.ROWID IN (SELECT message_id FROM chat_message_join WHERE chat_id IN (\(chatIDs.map(String.init).joined(separator: ","))))"
    }

    private func col(_ c: String, _ fallback: String) -> String { cols.contains(c) ? "m.\(c)" : fallback }

    private var select: String {
        """
        SELECT m.ROWID, m.text, m.attributedBody, h.id, m.date, m.is_from_me,
          \(col("item_type", "0")), \(col("group_action_type", "0")), \(cols.contains("other_handle") ? "oh.id" : "NULL"),
          \(col("associated_message_type", "0")), \(col("cache_has_attachments", "0")), \(col("date_edited", "0")),
          \(col("date_retracted", "0")), \(col("balloon_bundle_id", "NULL")), \(col("group_title", "NULL"))
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        \(cols.contains("other_handle") ? "LEFT JOIN handle oh ON oh.ROWID = m.other_handle" : "")
        """
    }

    private func fetch(_ whereClause: String, _ binds: [Bind]) throws -> [Msg] {
        try db.rows(select + " WHERE \(chatFilter) AND " + whereClause, binds).map { r in
            Msg(rowid: r.int(0), text: r.text(1), body: r.blob(2), handle: r.text(3), date: r.int(4), fromMe: r.int(5) != 0,
                itemType: r.int(6), groupAction: r.int(7), otherHandle: r.text(8), assocType: r.int(9),
                hasAttach: r.int(10) != 0, edited: r.int(11), retracted: r.int(12), balloon: r.text(13), groupTitle: r.text(14))
        }
    }

    private func initialCursor() throws -> Int64 {
        let rows = try db.rows("SELECT m.ROWID, m.date FROM message m WHERE \(chatFilter) ORDER BY m.ROWID DESC LIMIT 2000")
        let since = now.addingTimeInterval(-Double(cfg.backfill) * 86400)
        var cursor: Int64 = rows.first?.int(0) ?? 0
        for r in rows {
            if appleDate(r.int(1)) >= since { cursor = r.int(0) - 1 } else { break }
        }
        return max(cursor, 0)
    }

    private func textOf(_ m: Msg) -> String? {
        if let t = m.text, !cleanText(t).text.isEmpty { return t }
        if let b = m.body, let t = textFromAttributedBody(b), !cleanText(t).text.isEmpty { return t }
        return nil
    }

    private func attachments(_ m: Msg) throws -> String {
        guard m.hasAttach else { return "none" }
        guard hasAttachTables else { return "an attachment" }
        let rows = try db.rows("SELECT a.mime_type, a.uti FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ?", [.int(m.rowid)])
        if rows.isEmpty { return "an attachment" }
        var counts: [String: Int] = [:]
        for r in rows {
            let mime = (r.text(0) ?? r.text(1) ?? "").lowercased()
            let k = mime.hasPrefix("image") || mime.contains("jpeg") || mime.contains("png") || mime.contains("heic") ? "photo"
                : mime.hasPrefix("video") || mime.contains("movie") ? "video"
                : mime.hasPrefix("audio") ? "audio clip"
                : mime.contains("pdf") ? "PDF" : "file"
            counts[k, default: 0] += 1
        }
        return counts.keys.sorted().map { "\(counts[$0]!) \($0)\(counts[$0]! > 1 ? "s" : "")" }.joined(separator: ", ")
    }

    private func sender(_ fromMe: Bool, _ handle: String?) -> String {
        if fromMe { return "You" }
        guard let h = handle, !h.isEmpty else { return "Unknown sender" }
        if let n = cfg.senders?[h] ?? cfg.senders?[h.lowercased()] { return n }
        let key = String(sha256Hex(Data((alias + "|" + h.lowercased()).utf8)).prefix(16))
        if let l = ts.unknown[key] { return "Unknown member \(l)" }
        let l = letters(ts.unknown.count)
        ts.unknown[key] = l
        return "Unknown member \(l)"
    }

    private func letters(_ n: Int) -> String {
        let a = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        return n < 26 ? String(a[n]) : String(a[(n / 26 - 1) % 26]) + String(a[n % 26])
    }

    private func promptTime(_ v: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE yyyy-MM-dd HH:mm"
        return f.string(from: appleDate(v))
    }

    /// One message is one prompt line, and brackets can't fake another message's index.
    private func promptSafe(_ s: String) -> String {
        cleanText(s, flatten: true).text.replacingOccurrences(of: "[", with: "(").replacingOccurrences(of: "]", with: ")")
    }

    private func record(_ m: Msg, kind: String, summary: String, status: String = "ok", reason: String? = nil,
                        needs: Bool = false, deadline: String? = nil, facts: [String] = [], attach: String = "none",
                        corrects: Int64? = nil, truncated: Bool = false) -> Record {
        Record(thread: alias, rowid: m.rowid, sender: sender(m.fromMe, m.handle), sent_at: iso(appleDate(m.date)),
               kind: kind, needs_action: needs, deadline: deadline, summary: summary, facts: facts, attachments: attach,
               status: status, reason: reason, corrects: corrects, truncated: truncated ? true : nil)
    }

    private func notSummarized(_ m: Msg, _ reason: String, attach: String = "none", corrects: Int64? = nil) -> Record {
        let why = [
            "model_declined": "the on-device model declined it",
            "model_skipped": "the model skipped it",
            "copied_text": "every summary copied the original wording",
            "too_long": "it was too long",
            "unreadable": "its text couldn't be read",
            "app_message": "it's an app or rich message the reader can't read",
            "unsupported_language": "the model doesn't support its language",
            "model_error": "the model returned something unusable",
            "empty_summary": "the model returned an empty summary",
        ][reason] ?? reason
        return record(m, kind: "not_summarized", summary: "Couldn't summarize this message (\(why)). Read it in Messages.",
                      status: "not_summarized", reason: reason, attach: attach, corrects: corrects)
    }

    /// The guid came from a chat list in the user's folder. Check it still names the chat the owner saw:
    /// same display name, and at least half the members he saw. Otherwise refuse the thread.
    private func checkExpected(names: [String]) throws {
        guard cfg.expect_name != nil || cfg.expect_members != nil else {
            throw Failure("thread has no expect_name/expect_members; add it with imsg-reader-config add-thread so the reader can check it's the chat you picked")
        }
        if let want = cfg.expect_name, !want.isEmpty, !names.contains(want) {
            throw Failure("this thread's chat isn't named \"\(want)\" in chat.db. It may have been renamed, or the chat list was tampered with. Nothing was read. Re-add it with imsg-reader-config")
        }
        if let want = cfg.expect_members, !want.isEmpty, hasHandleJoin {
            let actual = Set(try db.rows("SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id IN (\(chatIDs.map(String.init).joined(separator: ",")))")
                .compactMap { $0.text(0) }.map { cleanText($0, maxChars: 200, flatten: true).text.lowercased() })
            let kept = want.filter { actual.contains($0.lowercased()) }.count
            if kept * 2 < want.count {
                throw Failure("fewer than half the members you saw when you picked this thread are in its chat. Nothing was read. Re-add it with imsg-reader-config")
            }
        }
    }

    // MARK: the run

    func process(state: inout ReaderState, health th: inout ThreadHealth) async throws {
        var names: [String] = []
        for g in cfg.guids {
            for r in try db.rows("SELECT ROWID, display_name FROM chat WHERE guid = ?", [.text(g)]) {
                chatIDs.append(r.int(0))
                names.append(cleanText(r.text(1) ?? "", maxChars: 60, flatten: true).text)
            }
        }
        guard !chatIDs.isEmpty else { throw Failure("no chat in chat.db has this thread's guid") }
        try checkExpected(names: names)
        th.chats = chatIDs.count
        if hasHandleJoin {
            th.members = Int(try db.rows("SELECT COUNT(DISTINCT handle_id) FROM chat_handle_join WHERE chat_id IN (\(chatIDs.map(String.init).joined(separator: ",")))").first?.int(0) ?? 0)
        }
        let members = th.members
        let joinedNames = names.joined(separator: " | ")
        log.notice("resolve thread=\(self.alias, privacy: .public) chats=\(self.chatIDs.count, privacy: .public) members=\(members, privacy: .public) name=\(joinedNames, privacy: .public)")

        if let existing = state.threads[alias] { ts = existing } else { ts.cursor = try initialCursor() }

        // New messages, oldest first, released once they're past the hold.
        let rows = try fetch("m.ROWID > ? ORDER BY m.ROWID LIMIT 200", [.int(ts.cursor)])
        let cutoff = now.addingTimeInterval(-Double(cfg.hold) * 60)
        var release: [Msg] = []
        for m in rows {
            let d = appleDate(m.date)
            if d <= cutoff || d > now.addingTimeInterval(3600) { release.append(m) } else { break }
        }
        th.held = rows.count - release.count

        var records: [Record] = []
        var pending: [Pending] = []
        for m in release {
            if m.assocType != 0 { th.reactions += 1; continue }
            if m.itemType != 0 {
                let who = sender(m.fromMe, m.handle)
                switch m.itemType {
                case 1:
                    let other = sender(false, m.otherHandle)
                    records.append(record(m, kind: "membership", summary: m.groupAction == 1 ? "\(who) removed \(other) from the group." : "\(who) added \(other) to the group."))
                case 2:
                    let title = cleanText(m.groupTitle ?? "", maxChars: 40, flatten: true).text
                    records.append(record(m, kind: "info", summary: title.isEmpty ? "\(who) removed the group name." : "\(who) renamed the group to \"\(title)\"."))
                case 3:
                    records.append(record(m, kind: "membership", summary: "\(who) left the group or changed its details."))
                default:
                    th.skipped_system += 1
                }
                continue
            }
            let attach = try attachments(m)
            let raw = textOf(m)
            if m.retracted > 0 || (m.edited > 0 && raw == nil && !m.hasAttach) {
                records.append(record(m, kind: "retraction", summary: "\(sender(m.fromMe, m.handle)) unsent a message."))
                continue
            }
            guard let raw else {
                if attach != "none" {
                    records.append(record(m, kind: "info", summary: "\(sender(m.fromMe, m.handle)) sent \(attach).", attach: attach))
                } else {
                    records.append(notSummarized(m, m.balloon != nil ? "app_message" : "unreadable"))
                }
                continue
            }
            let c = cleanText(raw, maxChars: 2000)
            pending.append(Pending(id: pending.count, msg: m, text: c.text, truncated: c.truncated, attach: attach, corrects: nil))
        }

        // Released messages edited or unsent since: corrections and retractions.
        let recentIDs = ts.recent.keys.compactMap { Int64($0) }.sorted()
        if !recentIDs.isEmpty {
            for m in try fetch("m.ROWID IN (\(recentIDs.map(String.init).joined(separator: ",")))", []) {
                guard var e = ts.recent[String(m.rowid)] else { continue }
                let raw = textOf(m)
                if (m.retracted > 0 && m.retracted != e.retracted) || (m.edited != e.edited && raw == nil && !m.hasAttach) {
                    records.append(record(m, kind: "retraction", summary: "\(sender(m.fromMe, m.handle)) unsent a message they'd sent earlier.", corrects: m.rowid))
                    ts.recent[String(m.rowid)] = nil
                    th.corrections += 1
                } else if m.edited != e.edited, let raw {
                    let c = cleanText(raw, maxChars: 2000)
                    pending.append(Pending(id: pending.count, msg: m, text: c.text, truncated: c.truncated, attach: try attachments(m), corrects: m.rowid))
                    e.edited = m.edited
                    ts.recent[String(m.rowid)] = e
                    th.corrections += 1
                }
            }
        }
        for (k, e) in ts.recent where now.timeIntervalSince1970 - e.released_at > 7200 { ts.recent[k] = nil }

        // Summarize on device.
        let outcomes = try await summarizeAll(pending)
        for p in pending {
            switch outcomes[p.id] ?? .failed("model_skipped") {
            case .ok(let v):
                records.append(record(p.msg, kind: p.corrects == nil ? v.kind : "correction",
                                      summary: p.corrects == nil ? v.summary : "Edited: " + v.summary,
                                      needs: v.needsAction, deadline: v.deadline, facts: v.facts, attach: p.attach,
                                      corrects: p.corrects, truncated: p.truncated))
            case .failed(let reason):
                records.append(notSummarized(p.msg, reason, attach: p.attach, corrects: p.corrects))
            }
        }
        th.not_summarized = records.filter { $0.status != "ok" }.count

        records.sort { ($0.rowid, $0.corrects ?? 0) < ($1.rowid, $1.corrects ?? 0) }
        for i in records.indices {
            ts.seq += 1
            records[i].seq = ts.seq
        }

        if !records.isEmpty {
            let lines = try records.map { String(decoding: try jsonData($0, pretty: false), as: UTF8.self) }.joined(separator: "\n") + "\n"
            let data = Data(lines.utf8)
            let first = release.first?.rowid ?? records.first!.rowid
            let last = release.last?.rowid ?? records.last!.rowid
            let name = "\(stamp(now))-\(alias)-r\(first)-\(last).jsonl"
            for agent in agents {
                let dir = stateDir + "/outbox/" + agent
                try ensureDir(dir)
                try atomicWrite(data, to: dir + "/" + name)
            }
            log.notice("release thread=\(self.alias, privacy: .public) agents=\(self.agents.joined(separator: ","), privacy: .public) rows=\(first, privacy: .public)-\(last, privacy: .public) records=\(records.count, privacy: .public) sha256=\(sha256Hex(data), privacy: .public)")
        }

        for p in pending where p.corrects == nil {
            ts.recent[String(p.msg.rowid)] = RecentEntry(edited: p.msg.edited, retracted: p.msg.retracted, released_at: now.timeIntervalSince1970)
        }
        if ts.recent.count > 500 {
            for k in ts.recent.sorted(by: { $0.value.released_at < $1.value.released_at }).prefix(ts.recent.count - 500).map(\.key) { ts.recent[k] = nil }
        }
        if let last = release.last { ts.cursor = last.rowid }
        th.messages_released = release.count
        th.records = records.count
        th.last_rowid = ts.cursor
        state.threads[alias] = ts
    }

    // MARK: summarizing

    /// One model call per message, with up to 8 earlier messages as context.
    private func summarizeAll(_ pending: [Pending]) async throws -> [Int: Outcome] {
        guard !pending.isEmpty else { return [:] }
        var history: [PromptMsg] = []
        if let firstNew = pending.first(where: { $0.corrects == nil })?.msg.rowid {
            let notReaction = cols.contains("associated_message_type") ? "m.associated_message_type = 0 AND " : ""
            let notSystem = cols.contains("item_type") ? "m.item_type = 0 AND " : ""
            let prior = try fetch("\(notReaction)\(notSystem)m.ROWID < ? ORDER BY m.ROWID DESC LIMIT 8", [.int(firstNew)])
            for m in prior.reversed() {
                guard let t = textOf(m) else { continue }
                history.append(PromptMsg(when: promptTime(m.date), sender: sender(m.fromMe, m.handle),
                                         text: promptSafe(cleanText(t, maxChars: 300).text)))
            }
        }
        var out: [Int: Outcome] = [:]
        for p in pending {
            let ctx = p.corrects == nil ? Array(history.suffix(8)) : []
            out[p.id] = try await runOne(p, context: ctx, strict: false)
            if p.corrects == nil {
                history.append(PromptMsg(when: promptTime(p.msg.date), sender: sender(p.msg.fromMe, p.msg.handle),
                                         text: promptSafe(String(p.text.prefix(300)))))
            }
        }
        return out
    }

    /// The week after the message, so "Saturday" is a lookup: "Wed 2026-11-18 (this message), Thu 2026-11-19, ..."
    private func days(after v: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEEE yyyy-MM-dd"
        let start = appleDate(v)
        var parts = [f.string(from: start) + " (the message's day)"]
        for i in 1...7 {
            if let d = Calendar.current.date(byAdding: .day, value: i, to: start) { parts.append(f.string(from: d)) }
        }
        return parts.joined(separator: ", ")
    }

    private func runOne(_ p: Pending, context: [PromptMsg], strict: Bool) async throws -> Outcome {
        let msg = PromptMsg(when: promptTime(p.msg.date), sender: sender(p.msg.fromMe, p.msg.handle), text: promptSafe(p.text))
        let item: ModelItem
        do {
            item = try await summarizer.summarize(days: days(after: p.msg.date), context: context, message: msg, strict: strict)
        } catch SumError.tooLarge {
            if !context.isEmpty { return try await runOne(p, context: [], strict: strict) }
            return .failed("too_long")
        } catch SumError.declined(let reason) {
            // Earlier messages can trip the model's guardrails too; try once with this message alone.
            if !context.isEmpty { return try await runOne(p, context: [], strict: strict) }
            return .failed(reason)
        }
        let v = validate(item, p)
        if case .failed("copied_text") = v, !strict { return try await runOne(p, context: context, strict: true) }
        return v
    }

    private func validate(_ it: ModelItem, _ p: Pending) -> Outcome {
        let s = capWords(cleanText(it.summary, flatten: true).text, 280)
        if s.isEmpty { return .failed("empty_summary") }
        // The copy check is for long messages: a short text can only be summarized in roughly its own
        // words, but a long one must not leave the Mac verbatim. Over 40 words, no 10-word run may survive.
        let sourceTokens = tokens(p.text)
        if sourceTokens.count > 40 && sharesRun(s, p.text, 10) { return .failed("copied_text") }
        let kind = modelKinds.contains(it.kind ?? "") ? it.kind! : "info"
        // Facts must come from this message, not from the earlier messages shown as context.
        let known = Set(sourceTokens)
        let facts = (it.facts ?? []).map { capWords(cleanText($0, flatten: true).text, 40) }.filter { f in
            let t = tokens(f)
            return !t.isEmpty && t.filter { known.contains($0) }.count * 2 >= t.count
        }.prefix(5)
        // A deadline has to be a real date near the message: a day before it to six months after.
        var deadline: String? = nil
        if let d = it.deadline, let day = isoDay(d) {
            let sent = appleDate(p.msg.date)
            if day >= sent.addingTimeInterval(-2 * 86400) && day <= sent.addingTimeInterval(183 * 86400) { deadline = d }
        }
        return .ok(Validated(summary: s, kind: kind, needsAction: it.needs_action ?? false, deadline: deadline, facts: Array(facts)))
    }
}

func tokens(_ s: String) -> [String] {
    s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
}

/// True if `a` contains a run of `n` consecutive words from `b`.
func sharesRun(_ a: String, _ b: String, _ n: Int) -> Bool {
    let tb = tokens(b), ta = tokens(a)
    guard tb.count >= n, ta.count >= n else { return false }
    var grams = Set<String>()
    for i in 0...(tb.count - n) { grams.insert(tb[i..<(i + n)].joined(separator: " ")) }
    for i in 0...(ta.count - n) where grams.contains(ta[i..<(i + n)].joined(separator: " ")) { return true }
    return false
}

func isoDay(_ s: String) -> Date? {
    guard s.count == 10 else { return nil }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.isLenient = false
    return f.date(from: s)
}
