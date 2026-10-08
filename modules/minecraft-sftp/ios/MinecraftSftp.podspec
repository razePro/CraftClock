Pod::Spec.new do |s|
  s.name           = 'MinecraftSftp'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS SFTP client for Minecraft server files'
  s.description    = 'An Expo local module backed by NMSSH for SFTP file management.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Minecraft Time Calculator'
  s.homepage       = 'https://expo.dev'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  # EAS links this pod from the local modules directory; this source is only podspec metadata.
  s.source         = { :git => 'https://github.com/expo/expo.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'NMSSH', '~> 2.3.1'
  s.source_files = '*.swift'
end
