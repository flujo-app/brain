; brain-setup.iss - builds brain-setup.exe, a graphical wizard around
; scripts/install.ps1.
;
; The exe is a BOOTSTRAPPER, not a classic file-copying installer: the wizard
; collects the same answers install.ps1 would ask interactively (mode, folder,
; desktop shortcut, execution policy), then runs install.ps1 unattended by
; passing those answers through the BRAIN_* environment variables. All the real
; work - checking for Git / Docker Desktop / Node.js, installing what is
; missing via winget, starting Docker Desktop and waiting for the engine,
; cloning the repo, building, registering the global 'brain' command - lives in
; install.ps1, so the one-liner installer and this exe can never drift apart.
;
; Re-running the exe on an existing install updates it (same as re-running the
; one-liner). No uninstaller is registered: what an uninstall must reverse is
; recorded by install.ps1 in install-manifest.json for a future uninstaller.
;
; Compile:  ISCC.exe brain-setup.iss            (Inno Setup 6)
;           ISCC.exe /DMyAppVersion=1.2.3 brain-setup.iss
; CI builds this automatically - see .github/workflows/installer.yml.

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MyBranch
  #define MyBranch "main"
#endif
#define MyAppName "brain"
#define MyAppURL "https://github.com/flujo-app/brain"

[Setup]
AppId={{98155F95-79F9-41BF-9C31-1497B9528B63}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=flujo-app
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={localappdata}\brain
DirExistsWarning=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
WizardStyle=modern
OutputDir=Output
OutputBaseFilename=brain-setup
Uninstallable=no
SetupLogging=yes

[Files]
; Carried inside the exe, extracted to {tmp} at install time and run from
; there. Deliberately NOT placed into {app}: install.ps1 git-clones into {app},
; and git clone requires the target directory to be empty.
Source: "..\scripts\install.ps1"; Flags: dontcopy

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"

[Run]
; Finish-page checkbox. The 'brain' launcher is written by install.ps1; in
; docker mode it runs `docker compose up -d` and opens the browser, in
; standalone mode it starts the Node server.
Filename: "{localappdata}\brain-cli\brain.cmd"; Description: "Start brain now"; \
  Flags: postinstall nowait shellexec skipifsilent; Check: BrainLauncherExists

[Messages]
WelcomeLabel2=This will install [name] on your computer - including anything it needs that is missing (Git, and Docker Desktop or Node.js).%n%nIt is recommended that you close all other applications before continuing.

[Code]
var
  ModePage: TInputOptionWizardPage;

function SetEnvironmentVariable(lpName: string; lpValue: string): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function BrainLauncherExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\brain-cli\brain.cmd'));
end;

// install.ps1 bootstraps every prerequisite through winget, so winget itself
// is the only thing setup must insist on up front.
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if not Exec('cmd.exe', '/c where winget >nul 2>nul', '', SW_HIDE,
              ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    MsgBox('winget (App Installer) was not found.' + #13#10#13#10 +
           'brain uses winget to install its prerequisites (Git, Docker Desktop / Node.js).' + #13#10 +
           'Install "App Installer" from the Microsoft Store, then run this setup again.',
           mbCriticalError, MB_OK);
    Result := False;
  end;
end;

procedure InitializeWizard();
begin
  ModePage := CreateInputOptionPage(wpWelcome,
    'How do you want to run brain?', '',
    'Both modes install everything they need automatically. Re-run this setup anytime to update brain or switch modes.',
    True, False);
  ModePage.Add('Docker - the full experience: lobby, grow-a-brain wizard, one isolated FLUJO per brain (installs Docker Desktop if missing)');
  ModePage.Add('Standalone - one brain, no Docker (installs Node.js if missing)');
  ModePage.Values[0] := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Mode: string;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;

  if ModePage.Values[1] then
    Mode := 'standalone'
  else
    Mode := 'docker';

  // Hand the wizard's answers to install.ps1 via its unattended-install
  // environment variables (inherited by the Exec'd process below).
  SetEnvironmentVariable('BRAIN_MODE', Mode);
  SetEnvironmentVariable('BRAIN_DIR', ExpandConstant('{app}'));
  SetEnvironmentVariable('BRAIN_BRANCH', '{#MyBranch}');
  if WizardIsTaskSelected('desktopicon') then
    SetEnvironmentVariable('BRAIN_SHORTCUT', '1')
  else
    SetEnvironmentVariable('BRAIN_SHORTCUT', '0');
  // Never start from inside install.ps1 (standalone start blocks forever);
  // the finish page's "Start brain now" checkbox launches it detached instead.
  SetEnvironmentVariable('BRAIN_START', '0');

  // Standalone mode runs npm (a .ps1 shim) on every start, which a fresh
  // Windows blocks. Same consent question install.ps1 would ask on a terminal.
  if Mode = 'standalone' then
  begin
    if MsgBox('Windows blocks running PowerShell scripts by default, and brain''s standalone mode needs to run npm (a PowerShell script) on every start.' + #13#10#13#10 +
              'Set the execution policy to RemoteSigned for your user account? (recommended)',
              mbConfirmation, MB_YESNO) = IDYES then
      SetEnvironmentVariable('BRAIN_SET_POLICY', '1')
    else
      SetEnvironmentVariable('BRAIN_SET_POLICY', '0');
  end;

  ExtractTemporaryFile('install.ps1');
  WizardForm.StatusLabel.Caption :=
    'Running the brain installer - a console window shows its progress ...';

  if not Exec('powershell.exe',
              '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}') + '\install.ps1"',
              '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Could not start PowerShell to run the installer.');

  if ResultCode <> 0 then
    RaiseException('The brain installer did not finish (exit code ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
                   'The console window shows the reason. The most common one: after a fresh Docker Desktop install, ' +
                   'Windows needs a log-out (sometimes a reboot) before the docker command works. ' +
                   'Log out and back in, start Docker Desktop once, then run this setup again - it picks up where it left off.');
end;
