// Shared by imsg-reader and imsg-reader-config: fixed paths, the config format and its validation.
import Foundation

enum Consts {
    static let version = "0.1.0"
    static let configDir = "/Library/Application Support/imsg-reader"
    static let configPath = configDir + "/config.json"
    static let readerPath = "/usr/local/libexec/imsg-reader"
    static let label = "com.nanoclaw.imsg-reader"
    static let plistPath = "/Library/LaunchAgents/com.nanoclaw.imsg-reader.plist"
    static let stateRel = "Library/Application Support/imsg-reader"
    #if TESTING
    static let subsystem = "com.nanoclaw.imsg-reader.test"
    #else
    static let subsystem = "com.nanoclaw.imsg-reader"
    #endif
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

struct ThreadConfig: Codable, Equatable {
    var guids: [String]
    var senders: [String: String]?
    var hold_minutes: Int?
    var backfill_days: Int?
    /// The chat name shown when you picked this thread ("" for an unnamed chat). The reader checks
    /// chat.db against it on every run, because the chat list you picked from sits in a folder any
    /// program running as you could rewrite.
    var expect_name: String?
    /// Member handles shown when you picked it. At least half must still be members.
    var expect_members: [String]?
    var hold: Int { hold_minutes ?? 15 }
    var backfill: Int { backfill_days ?? 2 }
}

struct AgentConfig: Codable, Equatable {
    var threads: [String]
}

struct ReaderConfig: Codable, Equatable {
    var version: Int?
    /// The macOS account whose Messages this reader serves. Other accounts' runs exit quietly.
    var user: String?
    var threads: [String: ThreadConfig]
    var agents: [String: AgentConfig]
    var setup: Bool?
    var retain_days: Int?
    var retain: Int { retain_days ?? 30 }
}

/// Thread and agent names end up in file names, so they are restricted to [a-z0-9-].
func isValidName(_ s: String) -> Bool {
    let u = Array(s.unicodeScalars)
    guard let f = u.first, u.count <= 40 else { return false }
    func ok(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("0"..."9").contains(c) }
    return ok(f) && u.allSatisfy { ok($0) || $0 == "-" }
}

/// Names that would let a sender pass as the owner or as the reader's own labels.
func isReservedSenderName(_ n: String) -> Bool {
    let l = n.lowercased()
    return l == "you" || l == "me" || l.hasPrefix("unknown")
}

func validateConfig(_ c: ReaderConfig) throws {
    if let u = c.user, u.isEmpty || u.count > 64 || cleanText(u).text != u {
        throw Failure("config: bad user")
    }
    for (alias, t) in c.threads {
        guard isValidName(alias) else { throw Failure("thread name '\(alias)' must be lowercase letters, digits and dashes, up to 40") }
        guard (1...4).contains(t.guids.count) else { throw Failure("thread \(alias): needs 1 to 4 guids") }
        for g in t.guids where g.isEmpty || g.count > 200 || cleanText(g).text != g {
            throw Failure("thread \(alias): bad guid")
        }
        guard (0...1440).contains(t.hold) else { throw Failure("thread \(alias): hold_minutes must be 0 to 1440") }
        guard (0...14).contains(t.backfill) else { throw Failure("thread \(alias): backfill_days must be 0 to 14") }
        if let n = t.expect_name, n.count > 60 || cleanText(n, flatten: true).text != n { throw Failure("thread \(alias): bad expect_name") }
        for h in t.expect_members ?? [] where h.isEmpty || h.count > 200 || cleanText(h, flatten: true).text != h {
            throw Failure("thread \(alias): bad expect_members entry")
        }
        for (h, n) in t.senders ?? [:] {
            guard !h.isEmpty, h.count <= 200, cleanText(h, flatten: true).text == h else { throw Failure("thread \(alias): bad sender handle") }
            guard !n.isEmpty, n.count <= 40, cleanText(n, flatten: true).text == n, !isReservedSenderName(n) else {
                throw Failure("thread \(alias): sender name '\(n)' isn't allowed (1-40 plain characters, not You/Me/Unknown...)")
            }
        }
    }
    for (agent, a) in c.agents {
        guard isValidName(agent) else { throw Failure("agent name '\(agent)' must be lowercase letters, digits and dashes, up to 40") }
        for t in a.threads where c.threads[t] == nil {
            throw Failure("agent \(agent) lists thread \(t), which isn't configured")
        }
    }
    guard (1...365).contains(c.retain) else { throw Failure("retain_days must be 1 to 365") }
}

func decodeConfig(_ d: Data) throws -> ReaderConfig {
    let c: ReaderConfig
    do { c = try JSONDecoder().decode(ReaderConfig.self, from: d) }
    catch { throw Failure("config.json doesn't parse: \(error.localizedDescription)") }
    try validateConfig(c)
    return c
}

func encodeConfig(_ c: ReaderConfig) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try e.encode(c) + Data("\n".utf8)
}
