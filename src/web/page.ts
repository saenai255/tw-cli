// The local setup page. Self-contained: inline CSS/JS plus /fingerprint2.js from this server.
const esc = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export function page({
  token,
  worlds,
  currentUrl,
  existingFp,
}: {
  token: string;
  /** Selectable worlds; the current env-configured one is added with id 0 when it is not in the list. */
  worlds: { id: number; name: string; url: string }[];
  currentUrl: string;
  existingFp: string | null;
}): string {
  const options = worlds
    .map(
      (world) =>
        `<option value="${world.id}"${world.url === currentUrl ? ' selected' : ''}>${esc(world.name)} · ${esc(new URL(world.url).host)}</option>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tw-cli setup</title>
<style>
:root{--bg:#f6f1e7;--card:#fffdf8;--ink:#2b2118;--mut:#7a6a58;--acc:#8a4b14;--ok:#2f7d32;--bad:#b3261e;--line:#e2d6c3}
@media (prefers-color-scheme:dark){:root{--bg:#1d1813;--card:#272019;--ink:#efe6d8;--mut:#ae9e8a;--acc:#e0a060;--ok:#7bc47f;--bad:#f2867d;--line:#3a3027}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
main{max-width:640px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 8px}code,.mono{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
label{display:block;font-size:13px;color:var(--mut);margin:10px 0 4px}input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--ink);font:inherit}
button{margin-top:14px;padding:9px 16px;border:0;border-radius:7px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:default}
.status{margin-top:10px;font-size:14px}.ok{color:var(--ok)}.bad{color:var(--bad)}.mut{color:var(--mut)}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 0;font-size:13px}dt{color:var(--mut)}dd{margin:0;overflow-wrap:anywhere}
</style></head><body><main>
<h1>tw-cli setup</h1>
<p class="sub">Runs only on this computer. Nothing on this page loads from InnoGames or any other site.</p>

<section>
<h2>1 · Browser fingerprint</h2>
<p class="mut">The game's own fingerprint code (Fingerprint2 1.8.0, same settings as <code>game.php</code>) runs in this browser.
Use the browser you normally play in, so the CLI reports the same device.</p>
<dl><dt>this browser</dt><dd class="mono" id="fp">computing…</dd>
<dt>saved</dt><dd class="mono" id="saved">${existingFp ? esc(existingFp) : '<span class="mut">none yet</span>'}</dd></dl>
<button id="saveFp" disabled>Save fingerprint</button>
<div class="status" id="fpStatus"></div>
</section>

<section>
<h2>2 · Log in</h2>
<p class="mut">All .net worlds. Your password goes only to the tw-cli process; it is not stored.</p>
<form id="login" autocomplete="on">
<label for="world">World</label><select id="world" name="world" required>${options}</select>
<label for="name">Account name</label><input id="name" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit" id="loginBtn">Log in</button>
</form>
<div class="status" id="loginStatus"></div>
</section>
</main>
<script src="/fingerprint2.js?t=${encodeURIComponent(token)}"></script>
<script>
(function(){
  var token=${JSON.stringify(token)}, profile=null;
  var byId=function(id){return document.getElementById(id)};
  function post(path, body){
    return fetch(path+'?t='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json','x-tw-token':token},body:JSON.stringify(body)})
      .then(function(response){return response.json().then(function(json){if(!response.ok)throw new Error(json.error||response.status);return json;});});
  }
  function status(id, className, text){var element=byId(id);element.className='status '+className;element.textContent=text;}
  // Exactly the options game.php passes (fp-script).
  var options={excludeDoNotTrack:true,excludeUserAgent:true,excludeHasLiedOs:true,excludePlugins:true};
  function run(){
    new Fingerprint2(options).get(function(fp, components){
      profile={capturedAt:new Date().toISOString(),userAgent:navigator.userAgent,
        languages:Array.from(navigator.languages||[navigator.language]),
        webdriver:navigator.webdriver===undefined?null:navigator.webdriver,fp:fp,components:components};
      byId('fp').textContent=fp+'  ('+components.length+' components)';
      var saved=byId('saved').textContent.trim();
      if(saved===fp) status('fpStatus','ok','Matches the saved fingerprint.');
      else if(/^[0-9a-f]{32}$/.test(saved)) status('fpStatus','bad','Differs from the saved one. Different browser or settings? Save to replace it.');
      byId('saveFp').disabled=false;
    });
  }
  // Like the game: run when the browser is idle.
  (window.requestIdleCallback||function(callback){setTimeout(callback,100)})(run);
  byId('saveFp').addEventListener('click',function(){
    byId('saveFp').disabled=true;
    post('/api/fingerprint',profile).then(function(json){
      byId('saved').textContent=json.fp;status('fpStatus','ok','Saved. The server re-checked the hash.');
    }).catch(function(error){status('fpStatus','bad',error.message);}).then(function(){byId('saveFp').disabled=false;});
  });
  byId('login').addEventListener('submit',function(event){
    event.preventDefault();byId('loginBtn').disabled=true;status('loginStatus','mut','Logging in… (requests are paced, this takes a few seconds)');
    post('/api/login',{name:byId('name').value,password:byId('password').value,world:Number(byId('world').value)}).then(function(json){
      byId('password').value='';
      status('loginStatus','ok','Logged in as '+json.name+' (level '+json.level+') on '+json.world+'. Session saved. You can close this page and run: tw');
    }).catch(function(error){status('loginStatus','bad',error.message);}).then(function(){byId('loginBtn').disabled=false;});
  });
})();
</script></body></html>`;
}
