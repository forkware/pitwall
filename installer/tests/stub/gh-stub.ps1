# Fake GitHub CLI for installer tests: logs every call and fakes only what the installers use.
$call = $args
Add-Content -Path $env:GH_STUB_LOG -Value ($call -join ' ')
switch ("$($call[0]) $($call[1])") {
  'auth status'    { exit 0 }
  'auth setup-git' { exit 0 }
  'repo edit'      { exit 0 }
  'repo fork' {
    $name = $call[2].Split('/')[-1]
    git init -q $name
    git -C $name remote add origin "https://github.com/tester/$name.git"
    exit $LASTEXITCODE
  }
  default {
    [Console]::Error.WriteLine("gh stub: unexpected call: gh $($call -join ' ')")
    exit 1
  }
}
