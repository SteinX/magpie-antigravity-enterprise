import Darwin
import Foundation
import Security

// This process owns flock until stdin closes. Credentials arrive only on stdin;
// stdout is a fixed status protocol, and neither errors nor credentials are logged.
guard CommandLine.arguments.count == 2 else { exit(2) }
let lockDescriptor = open(CommandLine.arguments[1], O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard lockDescriptor >= 0 else { exit(3) }
defer { close(lockDescriptor) }
guard flock(lockDescriptor, LOCK_EX) == 0 else { exit(4) }
FileHandle.standardOutput.write(Data("locked\n".utf8))

guard let line = readLine(), !line.isEmpty else { exit(0) }
guard let input = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      let expected = request["expected"],
      let replacement = request["replacement"] else { exit(5) }

let service = "gemini"
let account = "antigravity"
var length: UInt32 = 0
var password: UnsafeMutableRawPointer?
var item: SecKeychainItem?
let found = service.withCString { serviceBytes in
    account.withCString { accountBytes in
        SecKeychainFindGenericPassword(nil, UInt32(service.utf8.count), serviceBytes,
                                      UInt32(account.utf8.count), accountBytes,
                                      &length, &password, &item)
    }
}
guard found == errSecSuccess, let password, let item else { exit(6) }
let original = Data(bytes: password, count: Int(length))
SecKeychainItemFreeContent(nil, password)
guard original == Data(expected.utf8) else {
    FileHandle.standardOutput.write(Data("changed\n".utf8))
    exit(0)
}

// Update the existing item, preserving its attributes and ACL. Apple does not
// offer value-data CAS: an uncoordinated native-app write can still race this
// immediate comparison. Never create or delete a native credential item.
let updated = Data(replacement.utf8)
let result = updated.withUnsafeBytes { bytes in
    SecKeychainItemModifyAttributesAndData(item, nil, UInt32(bytes.count), bytes.baseAddress)
}
guard result == errSecSuccess else { exit(7) }
FileHandle.standardOutput.write(Data("saved\n".utf8))
