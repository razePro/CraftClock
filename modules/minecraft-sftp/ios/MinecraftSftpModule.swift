import ExpoModulesCore
import NMSSH

private enum SftpClientError: LocalizedError {
  case couldNotConnect
  case authenticationFailed
  case sftpUnavailable
  case hostKeyNotTrusted(String)
  case operationFailed(String)
  case invalidLocalFile

  var errorDescription: String? {
    switch self {
    case .couldNotConnect: return "Could not connect to the SFTP server. Check the host, port, and network."
    case .authenticationFailed: return "SFTP authentication failed. Check the username and password."
    case .sftpUnavailable: return "The SSH connection succeeded, but the SFTP service could not start."
    case .hostKeyNotTrusted(let fingerprint): return "SFTP host key changed or is not trusted. Presented fingerprint: \(fingerprint)"
    case .operationFailed(let operation): return "SFTP \(operation) failed. Check the path and your server permissions."
    case .invalidLocalFile: return "The selected local file is no longer available. Choose it again and retry."
    }
  }
}

public class MinecraftSftpModule: Module {
  private static let lock = NSRecursiveLock()

  public func definition() -> ModuleDefinition {
    Name("MinecraftSftp")

    AsyncFunction("getHostFingerprint") { (host: String, port: Int, username: String) throws -> String in
      try Self.withLock {
        let session = NMSSHSession(host: host, port: port, andUsername: username)
        session.timeout = 10
        guard session.connect() else { throw SftpClientError.couldNotConnect }
        defer { session.disconnect() }
        return session.fingerprint(.SHA1) ?? ""
      }
    }

    AsyncFunction("listDirectory") { (host: String, port: Int, username: String, password: String, fingerprint: String, path: String) throws -> [[String: Any]] in
      try Self.withSession(host: host, port: port, username: username, password: password, fingerprint: fingerprint) { sftp in
        guard let files = sftp.contentsOfDirectory(atPath: path) else { throw SftpClientError.operationFailed("directory listing") }
        return files.compactMap { item in
          guard let file = item as? NMSFTPFile, file.filename != ".", file.filename != ".." else { return nil }
          var result: [String: Any] = ["name": file.filename, "isDirectory": file.isDirectory]
          if let size = file.fileSize { result["size"] = size.intValue }
          if let date = file.modificationDate { result["modified"] = ISO8601DateFormatter().string(from: date) }
          return result
        }.sorted { left, right in
          let leftDir = left["isDirectory"] as? Bool ?? false
          let rightDir = right["isDirectory"] as? Bool ?? false
          if leftDir != rightDir { return leftDir }
          return (left["name"] as? String ?? "").localizedCaseInsensitiveCompare(right["name"] as? String ?? "") == .orderedAscending
        }
      }
    }

    AsyncFunction("createDirectory") { (host: String, port: Int, username: String, password: String, fingerprint: String, path: String) throws -> Bool in
      try Self.withSession(host: host, port: port, username: username, password: password, fingerprint: fingerprint) { sftp in
        guard sftp.createDirectory(atPath: path) else { throw SftpClientError.operationFailed("folder creation") }
        return true
      }
    }

    AsyncFunction("rename") { (host: String, port: Int, username: String, password: String, fingerprint: String, source: String, destination: String) throws -> Bool in
      try Self.withSession(host: host, port: port, username: username, password: password, fingerprint: fingerprint) { sftp in
        guard sftp.moveItem(atPath: source, toPath: destination) else { throw SftpClientError.operationFailed("rename") }
        return true
      }
    }

    AsyncFunction("delete") { (host: String, port: Int, username: String, password: String, fingerprint: String, path: String, isDirectory: Bool) throws -> Bool in
      try Self.withSession(host: host, port: port, username: username, password: password, fingerprint: fingerprint) { sftp in
        let removed = isDirectory ? sftp.removeDirectory(atPath: path) : sftp.removeFile(atPath: path)
        guard removed else { throw SftpClientError.operationFailed("delete") }
        return true
      }
    }

    AsyncFunction("download") { (host: String, port: Int, username: String, password: String, fingerprint: String, remotePath: String, fileName: String) throws -> String in
      try Self.withSession(host: host, port: port, username: username, password: password, fingerprint: fingerprint) { sftp in
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + Self.safeName(fileName))
        guard sftp.writeFile(atPath: remotePath, toFileAtPath: destination.path) else { throw SftpClientError.operationFailed("download") }
        return destination.absoluteString
      }
    }

    AsyncFunction("upload") { (host: String, port: Int, username: String, password: String, fingerprint: String, localUri: String, remotePath: String) throws -> Bool in
      try Self.withSession(host: host, port: port, username: username, password: password, fingerprint: fingerprint) { sftp in
        guard let localURL = URL(string: localUri), localURL.isFileURL, FileManager.default.fileExists(atPath: localURL.path) else { throw SftpClientError.invalidLocalFile }
        guard sftp.writeFile(atPath: localURL.path, toFileAtPath: remotePath) else { throw SftpClientError.operationFailed("upload") }
        return true
      }
    }
  }

  private static func withLock<T>(_ work: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try work()
  }

  private static func withSession<T>(host: String, port: Int, username: String, password: String, fingerprint: String, work: (NMSFTP) throws -> T) throws -> T {
    try withLock {
      let session = NMSSHSession(host: host, port: port, andUsername: username)
      session.timeout = 15
      guard session.connect() else { throw SftpClientError.couldNotConnect }
      defer { session.disconnect() }

      let actualFingerprint = session.fingerprint(.SHA1) ?? ""
      guard !fingerprint.isEmpty, actualFingerprint.caseInsensitiveCompare(fingerprint) == .orderedSame else {
        throw SftpClientError.hostKeyNotTrusted(actualFingerprint)
      }
      guard session.authenticate(byPassword: password), session.isAuthorized else { throw SftpClientError.authenticationFailed }
      guard session.sftp.connect() else { throw SftpClientError.sftpUnavailable }
      defer { session.sftp.disconnect() }
      return try work(session.sftp)
    }
  }

  private static func safeName(_ value: String) -> String {
    let name = URL(fileURLWithPath: value).lastPathComponent
    return name.isEmpty || name == "/" ? "download" : name
  }
}
