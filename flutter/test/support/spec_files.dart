import 'dart:io';

/// spec 디렉터리: 환경변수 FLR_SPEC_DIR, 없으면 저장소 상대 경로 ../spec (SPEC 8.1).
String specDir() {
  final env = Platform.environment['FLR_SPEC_DIR'];
  if (env != null && env.isNotEmpty) return env;
  return '../spec';
}

String readSpecFile(String name) => File('${specDir()}/$name').readAsStringSync();
