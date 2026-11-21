// Text cleaning shared by both binaries. Removes characters that can hide or disguise text.
import Foundation

/// Strips control, format (bidi, zero-width, Unicode tag), private-use and unassigned characters,
/// variation selectors and replacement/object characters. `flatten` turns line breaks into " / "
/// so one message is always one line. `maxChars` cuts the result and reports it.
func cleanText(_ s: String, maxChars: Int? = nil, flatten: Bool = false) -> (text: String, truncated: Bool) {
    var out = String.UnicodeScalarView()
    var newlines = 0
    for u in s.precomposedStringWithCanonicalMapping.unicodeScalars {
        let v = u.value
        if (0xFE00...0xFE0F).contains(v) || (0xE0100...0xE01EF).contains(v) || v == 0xFFFC || v == 0xFFFD { continue }
        var c = u
        switch u.properties.generalCategory {
        case .control:
            if u == "\n" { c = "\n" } else if u == "\t" { c = " " } else { continue }
        case .lineSeparator, .paragraphSeparator:
            c = "\n"
        case .format, .privateUse, .surrogate, .unassigned:
            continue
        default:
            break
        }
        if c == "\n" {
            if flatten {
                if !out.isEmpty { out.append(contentsOf: " / ".unicodeScalars) }
                continue
            }
            newlines += 1
            if newlines > 2 { continue }
        } else if c != " " {
            newlines = 0
        }
        out.append(c)
    }
    var text = String(out).trimmingCharacters(in: .whitespacesAndNewlines)
    if flatten {
        while text.hasSuffix(" /") { text = String(text.dropLast(2)).trimmingCharacters(in: .whitespaces) }
        while text.contains("/  / ") { text = text.replacingOccurrences(of: "/  / ", with: "/ ") }
        while text.contains(" /  /") { text = text.replacingOccurrences(of: " /  /", with: " /") }
    }
    var truncated = false
    if let m = maxChars, text.count > m {
        text = String(text.prefix(m))
        truncated = true
    }
    return (text, truncated)
}

/// Cuts at a word boundary at or before `max` characters.
func capWords(_ s: String, _ max: Int) -> String {
    guard s.count > max else { return s }
    let cut = String(s.prefix(max - 3))
    if let sp = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: sp) > max / 2 {
        return String(cut[..<sp]) + "..."
    }
    return cut + "..."
}
