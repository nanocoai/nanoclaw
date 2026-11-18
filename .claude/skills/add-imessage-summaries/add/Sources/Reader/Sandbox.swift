// The reader sandboxes itself before it reads anything. Full Disk Access then only reaches
// ~/Library/Messages, the process can't use the network or start other programs, and it can
// write only to its own state folder.
import Foundation

let sandboxProfile = """
(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec*)
(deny file-write*)
(allow file-write* (subpath (param "STATE")))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write-data (literal "/dev/null"))
(deny file-read* (subpath (param "HOME")))
(allow file-read-metadata (literal (param "HOME")))
(allow file-read* (subpath (string-append (param "HOME") "/Library/Messages")))
(allow file-read* (subpath (param "STATE")))
"""

private typealias SandboxInit = @convention(c) (
    UnsafePointer<CChar>, UInt64, UnsafePointer<UnsafePointer<CChar>?>, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> Int32

func applySandbox(home: String, state: String) throws {
    // RTLD_DEFAULT is (void *)-2 on Darwin.
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sandbox_init_with_parameters") else {
        throw Failure("sandbox: sandbox_init_with_parameters isn't available")
    }
    let fn = unsafeBitCast(sym, to: SandboxInit.self)
    let params = ["HOME", home, "STATE", state]
    let cstrs: [UnsafeMutablePointer<CChar>?] = params.map { strdup($0) }
    defer { cstrs.forEach { free($0) } }
    let ptrs: [UnsafePointer<CChar>?] = cstrs.map { $0.map { UnsafePointer($0) } } + [nil]
    var err: UnsafeMutablePointer<CChar>? = nil
    let rc = ptrs.withUnsafeBufferPointer { fn(sandboxProfile, 0, $0.baseAddress!, &err) }
    if rc != 0 {
        let msg = err.map { String(cString: $0) } ?? "rc \(rc)"
        throw Failure("sandbox failed: \(msg)")
    }
}

/// True only if the network and the rest of the home folder are both blocked for this process.
func sandboxIsActive(home: String) -> Bool {
    var netBlocked = false
    let s = socket(AF_INET, SOCK_STREAM, 0)
    if s < 0 {
        netBlocked = errno == EPERM || errno == EACCES
    } else {
        var a = sockaddr_in()
        a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        a.sin_family = sa_family_t(AF_INET)
        a.sin_port = in_port_t(9).bigEndian
        a.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &a) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        netBlocked = rc != 0 && (errno == EPERM || errno == EACCES)
        close(s)
    }
    let fd = open(home, O_RDONLY | O_DIRECTORY)
    let homeBlocked = fd < 0 && (errno == EPERM || errno == EACCES)
    if fd >= 0 { close(fd) }
    return netBlocked && homeBlocked
}

/// Release builds refuse to run if their own files could be swapped by a non-root user.
func checkRootOwned(_ path: String) throws {
    var st = stat()
    guard lstat(path, &st) == 0 else { throw Failure("\(path): \(String(cString: strerror(errno)))") }
    guard (st.st_mode & S_IFMT) != S_IFLNK else { throw Failure("\(path) is a symlink") }
    guard st.st_uid == 0 else { throw Failure("\(path) isn't owned by root") }
    guard st.st_mode & 0o022 == 0 else { throw Failure("\(path) is writable by group or others") }
}

func ownExecutablePath() -> String? {
    var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let n = proc_pidpath(getpid(), &buf, UInt32(buf.count))
    guard n > 0 else { return nil }
    return String(cString: buf)
}

func homeDirectory() -> String {
    if let pw = getpwuid(getuid()), let d = pw.pointee.pw_dir { return String(cString: d) }
    return NSHomeDirectory()
}

func userName() -> String {
    if let pw = getpwuid(getuid()), let n = pw.pointee.pw_name { return String(cString: n) }
    return ""
}
