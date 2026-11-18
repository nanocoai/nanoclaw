// imsg-reader: the only process with Full Disk Access. Design and threat model: the skill's docs.md.
// Release builds take no arguments. TESTING builds accept overrides so tests can use a fake chat.db.
import Foundation

func parseOptions() -> Options? {
    let args = Array(CommandLine.arguments.dropFirst())
    let home = homeDirectory()
    var o = Options(dbPath: home + "/Library/Messages/chat.db", home: home, stateDir: home + "/" + Consts.stateRel)
    #if TESTING
    o.ownerCheck = false
    var i = 0
    while i < args.count {
        let a = args[i]
        let v = i + 1 < args.count ? args[i + 1] : ""
        switch a {
        case "--config": o.configPath = v; i += 1
        case "--db": o.dbPath = v; i += 1
        case "--state": o.stateDir = v; i += 1
        case "--home": o.home = v; i += 1
        case "--summarizer": o.summarizer = v; i += 1
        case "--now":
            guard let d = ISO8601DateFormatter().date(from: v) else { return nil }
            o.now = d; i += 1
        case "--owner-check": o.ownerCheck = true
        case "--no-sandbox": o.sandbox = false
        default:
            FileHandle.standardError.write(Data("unknown option \(a)\n".utf8))
            return nil
        }
        i += 1
    }
    #else
    guard args.isEmpty else {
        FileHandle.standardError.write(Data("imsg-reader takes no arguments\n".utf8))
        return nil
    }
    #endif
    return o
}

guard let opts = parseOptions() else { exit(64) }
exit(await runReader(opts))
