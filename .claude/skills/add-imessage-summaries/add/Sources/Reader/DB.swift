// Read-only SQLite access to chat.db.
import Foundation
import SQLite3

enum Val {
    case null, int(Int64), real(Double), text(String), blob([UInt8])
}

struct Row {
    let vals: [Val]
    func int(_ i: Int) -> Int64 {
        switch vals[i] {
        case .int(let v): return v
        case .real(let d): return Int64(d)
        case .text(let s): return Int64(s) ?? 0
        default: return 0
        }
    }
    func text(_ i: Int) -> String? {
        switch vals[i] {
        case .text(let s): return s
        case .blob(let b): return String(bytes: b, encoding: .utf8)
        default: return nil
        }
    }
    func blob(_ i: Int) -> [UInt8]? {
        if case .blob(let b) = vals[i] { return b }
        return nil
    }
}

enum Bind {
    case int(Int64), text(String)
}

final class ChatDB {
    private var h: OpaquePointer?

    init(path: String) throws {
        // Check plain file access first, so a missing Full Disk Access grant reads as that, not as an SQLite error.
        let fd = open(path, O_RDONLY)
        if fd < 0 {
            let e = errno
            if e == EPERM || e == EACCES {
                throw Failure("can't open chat.db: operation not permitted. Full Disk Access is missing for \(Consts.readerPath) (or the sandbox blocked this path)")
            }
            throw Failure("can't open chat.db: \(String(cString: strerror(e)))")
        }
        close(fd)
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "?#%")
        let enc = path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
        let rc = sqlite3_open_v2("file:\(enc)?mode=ro", &h, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
        guard rc == SQLITE_OK else {
            let msg = h.map { String(cString: sqlite3_errmsg($0)) } ?? "rc \(rc)"
            sqlite3_close(h)
            h = nil
            throw Failure("can't open chat.db: \(msg)")
        }
        sqlite3_busy_timeout(h, 5000)
        try exec("PRAGMA query_only = 1")
    }

    deinit { sqlite3_close(h) }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(h, sql, nil, nil, &err) != SQLITE_OK {
            let m = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw Failure("chat.db: \(m)")
        }
    }

    func rows(_ sql: String, _ binds: [Bind] = []) throws -> [Row] {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(h, sql, -1, &st, nil) == SQLITE_OK else {
            throw Failure("chat.db query: \(String(cString: sqlite3_errmsg(h)))")
        }
        defer { sqlite3_finalize(st) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, b) in binds.enumerated() {
            switch b {
            case .int(let v): sqlite3_bind_int64(st, Int32(i + 1), v)
            case .text(let s): sqlite3_bind_text(st, Int32(i + 1), s, -1, transient)
            }
        }
        var out: [Row] = []
        while true {
            let rc = sqlite3_step(st)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw Failure("chat.db read: \(String(cString: sqlite3_errmsg(h)))") }
            let n = sqlite3_column_count(st)
            var vals: [Val] = []
            vals.reserveCapacity(Int(n))
            for c in 0..<n {
                switch sqlite3_column_type(st, c) {
                case SQLITE_INTEGER: vals.append(.int(sqlite3_column_int64(st, c)))
                case SQLITE_FLOAT: vals.append(.real(sqlite3_column_double(st, c)))
                case SQLITE_TEXT: vals.append(.text(String(cString: sqlite3_column_text(st, c))))
                case SQLITE_BLOB:
                    let len = Int(sqlite3_column_bytes(st, c))
                    if len > 0, let p = sqlite3_column_blob(st, c) {
                        vals.append(.blob(Array(UnsafeRawBufferPointer(start: p, count: len))))
                    } else {
                        vals.append(.blob([]))
                    }
                default: vals.append(.null)
                }
            }
            out.append(Row(vals: vals))
        }
        return out
    }

    func columns(_ table: String) throws -> Set<String> {
        Set(try rows("SELECT name FROM pragma_table_info(?)", [.text(table)]).compactMap { $0.text(0) })
    }

    func tableExists(_ table: String) throws -> Bool {
        try !rows("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [.text(table)]).isEmpty
    }
}

/// chat.db dates are nanoseconds (older rows: seconds) since 2001-01-01.
func appleDate(_ v: Int64) -> Date {
    let secs = v > 100_000_000_000 ? Double(v) / 1e9 : Double(v)
    return Date(timeIntervalSince1970: secs + 978_307_200)
}
