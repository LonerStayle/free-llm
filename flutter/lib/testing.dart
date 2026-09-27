/// 적합성 러너 코어 (SPEC 8.1·8.2). 앱 코드용이 아니다.
///
/// 호스트 테스트(`test/`)와 기기 integration_test 가 같이 쓴다. `spec/test-cases.json` 내용을
/// 문자열로 넘긴다(기기에서는 assets 로 복사한 것, SPEC 8.2).
///
/// ```dart
/// final report = await runConformance(testCasesJson: json, mockUrl: 'http://10.0.2.2:53817');
/// print(report.format());
/// ```
library;

export 'src/testing/conformance.dart';
export 'src/testing/script_book.dart' show ScriptBook, ScriptedResponse, materialize, validateResponses;
