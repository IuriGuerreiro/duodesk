Pod::Spec.new do |s|
  s.name = 'DuoDeskTestVideo'
  s.version = '0.1.0'
  s.summary = 'Native DuoDesk test-video sender'
  s.description = 'AVFoundation clip source, pinned TLS signaling and WebRTC sender.'
  s.license = { :type => 'PolyForm-Noncommercial-1.0.0', :file => '../../../../../LICENSE.md' }
  s.author = 'DuoDesk contributors'
  s.homepage = 'https://github.com/IuriGuerreiro/duodesk'
  s.source = { :git => 'https://github.com/IuriGuerreiro/duodesk.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC', '155.0.0'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'Security', 'CryptoKit'
  s.source_files = '*.{swift,h,m}'
  s.resource_bundles = { 'DuoDeskTestVideo' => ['Resources/test-pattern.mp4'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
