import Darwin
import Foundation
import Security

// Both operations run as the same persistent signed executable. The interaction
// policy belongs to this process only; background callers always disable UI.
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2,
      arguments[0] == "read" || arguments[0] == "lock",
      arguments[1] == "interactive" || arguments[1] == "noninteractive" else { exit(2) }
let operation = arguments[0]
let interactive = arguments[1] == "interactive"
guard SecKeychainSetUserInteractionAllowed(interactive) == errSecSuccess else { exit(14) }

func fail(_ status: OSStatus) -> Never {
    switch status {
    case errSecItemNotFound: exit(10)
    case errSecInteractionNotAllowed, errSecInteractionRequired: exit(11)
    case errSecAuthFailed: exit(12)
    case errSecUserCanceled: exit(13)
    default: exit(14)
    }
}

let requiredCount = operation == "read" ? 2 : 3
var keychain: SecKeychain?
if arguments.count == requiredCount + 2 {
    // Isolated native regression fixtures supply an explicit private keychain.
    // Production never sends this option; do not modify the user's search list.
    guard arguments[requiredCount] == "--keychain" else { exit(2) }
    let opened = arguments[requiredCount + 1].withCString { SecKeychainOpen($0, &keychain) }
    guard opened == errSecSuccess else { fail(opened) }
} else if arguments.count != requiredCount { exit(2) }

let service = "gemini"
let account = "antigravity"
func credential() -> (Data, SecKeychainItem) {
    var length: UInt32 = 0
    var password: UnsafeMutableRawPointer?
    var item: SecKeychainItem?
    let found = service.withCString { serviceBytes in
        account.withCString { accountBytes in
            SecKeychainFindGenericPassword(keychain, UInt32(service.utf8.count), serviceBytes,
                                          UInt32(account.utf8.count), accountBytes,
                                          &length, &password, &item)
        }
    }
    guard found == errSecSuccess else { fail(found) }
    guard let password, let item else { exit(14) }
    let data = Data(bytes: password, count: Int(length))
    SecKeychainItemFreeContent(nil, password)
    return (data, item)
}

if operation == "read" {
    // Only a successful read may put a credential on the private stdout pipe.
    FileHandle.standardOutput.write(credential().0)
    exit(0)
}

// This process owns flock until stdin closes. Lock stdout is a fixed protocol;
// credentials arrive only on stdin and are never printed, including on error.
let lockDescriptor = open(arguments[2], O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard lockDescriptor >= 0 else { exit(3) }
defer { close(lockDescriptor) }
var lockInfo = stat()
guard fstat(lockDescriptor, &lockInfo) == 0,
      lockInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
      lockInfo.st_uid == getuid(), lockInfo.st_mode & 0o077 == 0 else { exit(3) }
guard flock(lockDescriptor, LOCK_EX) == 0 else { exit(4) }
FileHandle.standardOutput.write(Data("locked\n".utf8))

guard let line = readLine(), !line.isEmpty else { exit(0) }
guard let input = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      let expected = request["expected"],
      let replacement = request["replacement"] else { exit(5) }
let (original, item) = credential()
guard original == Data(expected.utf8) else {
    FileHandle.standardOutput.write(Data("changed\n".utf8))
    exit(0)
}

// Preserve the existing attributes and ACL. There is no legacy value-data CAS
// against an uncoordinated app write, nor a safe write-authorization preflight
// without modifying the item. Never create/delete or change access controls.
let updated = Data(replacement.utf8)
let result = updated.withUnsafeBytes { bytes in
    SecKeychainItemModifyAttributesAndData(item, nil, UInt32(bytes.count), bytes.baseAddress)
}
guard result == errSecSuccess else { fail(result) }
FileHandle.standardOutput.write(Data("saved\n".utf8))
