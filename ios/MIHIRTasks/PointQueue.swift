import Foundation

/// Offline queue of location fixes, kept as a JSON file in Application Support. A fix is removed
/// only after the server has answered for it, so a site without signal just uploads later.
/// Each entry remembers the upload token of its session (fixes from an earlier session still go
/// to that session).
final class PointQueue {
    struct Entry: Codable { let id: String; let token: String; let url: String; let t: Double; let point: [String: CodableValue] }
    private var entries: [Entry] = []
    private let file: URL
    private let lock = NSLock()
    private let maxEntries = 20000

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("location_queue.json")
        if let data = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([Entry].self, from: data) { entries = list }
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return entries.count }

    func add(_ e: Entry) {
        lock.lock()
        if !entries.contains(where: { $0.id == e.id }) { entries.append(e) }
        if entries.count > maxEntries { entries.removeFirst(entries.count - maxEntries) }
        save(); lock.unlock()
    }
    /// The oldest batch belonging to one token.
    func nextBatch(max: Int) -> (token: String, url: String, entries: [Entry])? {
        lock.lock(); defer { lock.unlock() }
        guard let first = entries.min(by: { $0.t < $1.t }) else { return nil }
        let batch = entries.filter { $0.token == first.token }.sorted { $0.t < $1.t }.prefix(max)
        return (first.token, first.url, Array(batch))
    }
    func remove(ids: Set<String>) { lock.lock(); entries.removeAll { ids.contains($0.id) }; save(); lock.unlock() }
    func remove(token: String) { lock.lock(); entries.removeAll { $0.token == token }; save(); lock.unlock() }
    private func save() {
        if let data = try? JSONEncoder().encode(entries) { try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }
}

/// Minimal JSON value for storing a point dictionary.
enum CodableValue: Codable {
    case number(Double), string(String), bool(Bool)
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .string(try c.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .number(let n): try c.encode(n); case .string(let s): try c.encode(s); case .bool(let b): try c.encode(b) }
    }
    var any: Any { switch self { case .number(let n): return n; case .string(let s): return s; case .bool(let b): return b } }
}
