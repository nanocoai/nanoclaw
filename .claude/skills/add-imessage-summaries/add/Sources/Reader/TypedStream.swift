// Pulls the plain string out of a message's attributedBody (an NSArchiver "typedstream").
// Deliberately not a general unarchiver: these bytes come from other people's messages, and this
// process holds Full Disk Access, so it only walks to the string's length and copies the bytes.
import Foundation

func textFromAttributedBody(_ b: [UInt8]) -> String? {
    let n = b.count
    guard n > 0, n <= 20_000_000 else { return nil }
    for marker in [Array("NSString".utf8), Array("NSMutableString".utf8)] {
        guard let start = indexOf(b, marker) else { continue }
        var i = start + marker.count
        let end = min(n, i + 16)
        var plus: Int? = nil
        while i < end {
            if b[i] == 0x2B { plus = i; break }
            i += 1
        }
        guard let p = plus else { continue }
        i = p + 1
        guard i < n else { return nil }
        let tag = b[i]
        i += 1
        var len = 0
        switch tag {
        case 0x81:
            guard i + 2 <= n else { return nil }
            len = Int(b[i]) | Int(b[i + 1]) << 8
            i += 2
        case 0x82:
            guard i + 4 <= n else { return nil }
            len = Int(b[i]) | Int(b[i + 1]) << 8 | Int(b[i + 2]) << 16 | Int(b[i + 3]) << 24
            i += 4
        case 0x00...0x7F:
            len = Int(tag)
        default:
            return nil
        }
        guard len > 0, len <= n - i else { return nil }
        return String(bytes: b[i..<(i + len)], encoding: .utf8)
    }
    return nil
}

private func indexOf(_ hay: [UInt8], _ needle: [UInt8]) -> Int? {
    let m = needle.count
    guard m > 0, hay.count >= m else { return nil }
    var i = 0
    while i <= hay.count - m {
        if hay[i] == needle[0] {
            var j = 1
            while j < m && hay[i + j] == needle[j] { j += 1 }
            if j == m { return i }
        }
        i += 1
    }
    return nil
}
