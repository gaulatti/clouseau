public func sign(_ value: Int) -> Int {
  if value < 0 {
    return -1
  }
  return value == 0 ? 0 : 1
}
