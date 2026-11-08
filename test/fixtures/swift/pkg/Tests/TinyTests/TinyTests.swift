import XCTest
@testable import Tiny

final class TinyTests: XCTestCase {
  func testSign() {
    XCTAssertEqual(sign(-5), -1)
    XCTAssertEqual(sign(0), 0)
    XCTAssertEqual(sign(3), 1)
  }

  func testIdle() {
    XCTAssertEqual(idle(), 7)
  }
}
