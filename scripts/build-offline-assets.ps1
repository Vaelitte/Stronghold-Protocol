$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $taskRoot 'public\offline-assets.zip'
$temporary = Join-Path $taskRoot '.cache\offline-assets.zip.tmp'
if (-not ([IO.Path]::GetFullPath($output).StartsWith($taskRoot + '\')) -or -not ([IO.Path]::GetFullPath($temporary).StartsWith($taskRoot + '\'))) { throw 'Unexpected output path' }
New-Item -ItemType Directory -Path (Split-Path -Parent $temporary) -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($temporary, [IO.FileMode]::Create)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($kind in @('assets','fonts')) {
    $directory = Join-Path $taskRoot "public\$kind"
    foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -File) {
      $relative = $kind + '/' + $file.FullName.Substring($directory.Length + 1).Replace('\','/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Fastest) | Out-Null
      $count++
    }
  }
} finally { $archive.Dispose(); $stream.Dispose() }
Move-Item -LiteralPath $temporary -Destination $output -Force
Write-Output "Offline pack ready: $count files; $((Get-Item -LiteralPath $output).Length) bytes"
