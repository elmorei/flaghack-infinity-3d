using System;
using System.IO;
using System.Reflection;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Text.RegularExpressions;
[assembly: AssemblyTitle("Flaghack Launcher")]
[assembly: AssemblyVersion("1.0.0.0")]
class Launcher : Form {
 TextBox repo=new TextBox(), branch=new TextBox(); CheckBox host=new CheckBox();
 string config=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FlaghackLauncher","launcher.txt");
 Launcher(){
 Text="Flaghack Launcher";ClientSize=new Size(520,275);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;
 Label title=new Label{Text="Choose your version of Flaghack",Left=20,Top=18,Width=470,Height=26,Font=new Font(SystemFonts.DefaultFont.FontFamily,13,FontStyle.Bold)};Controls.Add(title);
 Controls.Add(new Label{Text="GitHub repository (owner/repo or URL)",Left=20,Top=57,Width=470});repo.SetBounds(20,82,480,24);repo.Text="elmorei/flaghack-infinity-3d";Controls.Add(repo);
 Controls.Add(new Label{Text="Branch (blank uses the repository's default)",Left=20,Top=115,Width=470});branch.SetBounds(20,140,480,24);branch.Text="iteration";Controls.Add(branch);
 host.Text="Run a local multiplayer host (password shown in console)";host.SetBounds(20,178,480,24);Controls.Add(host);
 Button launch=new Button{Text="Check for updates && Launch",Left=20,Top=215,Width=280,Height=36};launch.Click+=Launch;Controls.Add(launch);
 Controls.Add(new Label{Text="Windows 10/11 • Internet required",Left=310,Top=226,Width=200});
 try{if(File.Exists(config)){var lines=File.ReadAllLines(config);if(lines.Length>0)repo.Text=lines[0];if(lines.Length>1)branch.Text=lines[1];}}catch{}
 }
 void Launch(object sender,EventArgs ev){try{
 string name=repo.Text.Trim();if(name.StartsWith("https://github.com/",StringComparison.OrdinalIgnoreCase))name=name.Substring(19).TrimEnd('/');if(name.EndsWith(".git"))name=name.Substring(0,name.Length-4);
 if(!Regex.IsMatch(name,@"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))throw new Exception("Enter a GitHub repository as owner/repo or its URL.");
 string b=branch.Text.Trim();if(b.Length>200||b.Contains("\"")||b.Contains("\r")||b.Contains("\n"))throw new Exception("Invalid branch name.");
 Directory.CreateDirectory(Path.GetDirectoryName(config));File.WriteAllLines(config,new[]{name,b});
 string script=Path.Combine(Path.GetDirectoryName(config),"launch-v1.ps1");using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("launch.ps1"))using(var output=File.Create(script)){stream.CopyTo(output);}
 // UTF-16 base64 transports data without command-line or PowerShell interpolation.
 string command="& '"+script.Replace("'","''")+"' -Repository '"+name+"' -Branch '"+b.Replace("'","''")+"'"+(host.Checked?" -HostGame":"");
 string encoded=Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(command));
 Process.Start(new ProcessStartInfo("powershell.exe","-NoProfile -ExecutionPolicy Bypass -EncodedCommand "+encoded){UseShellExecute=true});
 }catch(Exception ex){MessageBox.Show(ex.Message,"Unable to launch",MessageBoxButtons.OK,MessageBoxIcon.Error);}}
 [STAThread] static void Main(){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new Launcher());}
}
