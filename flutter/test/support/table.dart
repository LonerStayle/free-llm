import 'package:free_llm_router/testing.dart';

/// 파일 끝에서 참조 러너와 같은 표를 찍기 위한 결과 모음.
class ResultTable {
  ResultTable(this.caseOrder);

  final List<String> caseOrder;
  final List<CaseResult> results = [];
  final Map<String, List<String>> configResults = {};

  void printTable() {
    if (results.isEmpty && configResults.isEmpty) return;
    final ordered = List.of(results)
      ..sort((a, b) => caseOrder.indexOf(a.name).compareTo(caseOrder.indexOf(b.name)));
    // ignore: avoid_print
    print('\n${ConformanceReport(ordered, configResults).format()}\n');
  }
}
