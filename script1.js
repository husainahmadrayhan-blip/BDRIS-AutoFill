
const $ = id => document.getElementById(id);
const AUTH_KEY='BDRIS_AUTH_TOKEN_V1', DEVICE_KEY='BDRIS_DEVICE_ID_V1';
const accessToken=new URLSearchParams(location.search).get('access') || sessionStorage.getItem('BDRIS_ACCESS_TOKEN') || '';
function getDeviceId(){let id=localStorage.getItem(DEVICE_KEY);if(!id){id=crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);localStorage.setItem(DEVICE_KEY,id)}return id}
const API_BASE=(location.protocol==='file:'?'http://localhost:3000':''); const originalFetch=window.fetch.bind(window);window.fetch=async function(input,init={}){const url=typeof input==='string'?input:(input?.url||'');if(url.startsWith('/api/')&&!url.includes('/api/auth/login')&&!url.includes('/api/auth/admin-login'))init={...init,headers:{...(init.headers||{}),Authorization:'Bearer '+(localStorage.getItem(AUTH_KEY)||''),'X-Device-Id':getDeviceId()}};return originalFetch((typeof input==='string'&&input.startsWith('/api/')&&location.protocol==='file:')?API_BASE+input:input,init)};
async function doLogin(e){e.preventDefault();const btn=$('loginBtn'),msg=$('loginMessage'),screen=$('loginScreen');screen.classList.remove('login-error','login-success','child-pull');screen.classList.add('child-pull');msg.className='login-message';msg.textContent='Verifying secure access…';btn.disabled=true;btn.classList.add('loading');try{if(!accessToken)throw Error('এই Login Link-এ access code নেই। Admin থেকে তৈরি করা user link ব্যবহার করুন।');const r=await originalFetch((location.protocol==='file:'?API_BASE:'')+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('loginUsername').value.trim(),password:$('loginPassword').value,accessToken,deviceId:getDeviceId()})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw Error(d.error||'Login failed');localStorage.setItem(AUTH_KEY,d.token);localStorage.setItem('BDRIS_USER_ID',d.user.id);sessionStorage.setItem('BDRIS_ACCESS_TOKEN',accessToken);screen.classList.add('login-success');msg.className='login-message success';msg.textContent='Login successful. Opening system…';setTimeout(()=>{screen.classList.add('hidden');document.body.classList.remove('login-locked')},650)}catch(err){screen.classList.add('login-error');msg.className='login-message error';msg.textContent=(err&&err.name==='TypeError'&&/fetch/i.test(err.message))?'Server Connection Error: Server চালু নেই বা এই page সরাসরি file:// থেকে খোলা হয়েছে। RUN-SERVER.bat চালু করে http://localhost:3000 খুলুন।':(/Username বা Password ভুল/i.test(err.message||'')?'সঠিক পাসওয়ার্ড দিন।':(err.message||'Login failed'))}finally{btn.disabled=false;btn.classList.remove('loading')}}
async function bootAuth(){const token=localStorage.getItem(AUTH_KEY);if(!token)return;try{const r=await originalFetch('/api/auth/me',{headers:{Authorization:'Bearer '+token,'X-Device-Id':getDeviceId()}});if(r.ok){const d=await r.json().catch(()=>null);if(!accessToken||d?.session?.accessToken===accessToken){$('loginScreen').classList.add('hidden');document.body.classList.remove('login-locked');return}}}catch(_){}localStorage.removeItem(AUTH_KEY)}
$('loginForm').addEventListener('submit',doLogin);bootAuth();

let currentSessionId = null;
let mathCaptchaA = 0, mathCaptchaB = 0, mathCaptchaOp = '+';
let mathCaptchaSolved = false;
let currentData = null;
let pdfBlob = null;
let pdfUrl = null;
let currentQRImage = "";
let currentQRLabel = "";
let certificateType = 'new';
let registrationMode = 'birth';
let selectedBengaliFont = 'NikoshLight';
let editingHistoryId = null;
const PDF_HISTORY_DB_BASE = 'BDRIS_PDF_HISTORY_V1';
function getPDFHistoryDBName(){ return PDF_HISTORY_DB_BASE + '_' + (localStorage.getItem('BDRIS_USER_ID') || 'guest'); }
const PDF_HISTORY_STORE = 'pdfs';
const PDF_FIELD_IDS = ['in_nameBn','in_nameEn','in_dob','in_birthDate','in_sex','in_inWord','in_brn','in_regDate','in_issuanceDate','in_registrationOffice','in_upazilaPouroshavaUnion','in_fatherBn','in_fatherEn','in_fatherNationalityBn','in_fatherNationalityEn','in_motherBn','in_motherEn','in_motherNationalityBn','in_motherNationalityEn','in_pobBn','in_pobEn','in_addrBn','in_addrEn','in_deathCauseBn','in_deathCauseEn'];

let pdfImageLibrary = [];
let selectedPDFImageId = '';
let selectedPDFImageName = '';
let selectedPDFImageDataUrl = '';
let pendingPDFImageId = '';
let imagePositionX = 105;
let imagePositionY = 247;
let imageZoom = 100;
let imageWidth = 24;
let imageHeight = 10;
let pdfPreviewRefreshTimer = null;
let pdfPreviewNeedsHistorySave = false;

function updatePDFImageAdjustUI(){
  const frame=$('certIframe');
  if(frame && frame.contentWindow) frame.contentWindow.postMessage({type:'pdf-image-sync',x:imagePositionX,y:imagePositionY,w:imageWidth,h:imageHeight,z:imageZoom},'*');
}
function setPDFImageAdjust(axis,value){
  const n=Number(value)||0;
  if(axis==='x')imagePositionX=Math.max(0,Math.min(210,n));
  if(axis==='y')imagePositionY=Math.max(0,Math.min(297,n));
  if(axis==='z')imageZoom=Math.max(50,Math.min(300,n));
  if(axis==='w')imageWidth=Math.max(8,Math.min(180,n));
  if(axis==='h')imageHeight=Math.max(5,Math.min(250,n));
  pdfBlob=null; if(pdfUrl){URL.revokeObjectURL(pdfUrl);pdfUrl=null;} pdfPreviewNeedsHistorySave=true;
  updatePDFImageAdjustUI();
}
function applyPDFImagePreset(pos){
  const p=pos||{};
  imagePositionX=Number.isFinite(Number(p.x))?Math.max(0,Math.min(210,Number(p.x))):105;
  imagePositionY=Number.isFinite(Number(p.y))?Math.max(0,Math.min(297,Number(p.y))):247;
  imageWidth=Number.isFinite(Number(p.width))?Math.max(8,Math.min(180,Number(p.width))):24;
  imageHeight=Number.isFinite(Number(p.height))?Math.max(5,Math.min(250,Number(p.height))):10;
  imageZoom=Number.isFinite(Number(p.zoom))?Math.max(50,Math.min(300,Number(p.zoom))):100;
}
function resetPDFImageAdjust(){imagePositionX=105;imagePositionY=247;imageZoom=100;imageWidth=24;imageHeight=10;updatePDFImageAdjustUI();status('Image position ও size reset হয়েছে।','ok');}
function buildInteractivePreviewHtml(baseHtml){
  if(!selectedPDFImageDataUrl) return baseHtml;
  const safeX=Number(imagePositionX)||105, safeY=Number(imagePositionY)||247;
  const safeW=Math.max(8,Math.min(180,Number(imageWidth)||24));
  const safeH=Math.max(5,Math.min(250,Number(imageHeight)||10));
  const editor=`<div class="pdf-image-editor-frame" id="pdfImageEditorFrame">
    <div class="pdf-image-editor-box" id="pdfImageEditorBox">
      <img id="pdfImageEditorImg" src="${String(selectedPDFImageDataUrl).replace(/"/g,'&quot;')}" alt="Selected PDF Image">
      <i class="h nw"></i><i class="h n"></i><i class="h ne"></i><i class="h e"></i>
      <i class="h se"></i><i class="h s"></i><i class="h sw"></i><i class="h w"></i>
    </div>
  </div>`;
  const html=baseHtml.replace(/<div class="pdf-image-overlay">[\s\S]*?<\/div>/, editor);
  const script=`<style>
.pdf-image-editor-frame{position:absolute;left:0;top:0;width:210mm;height:297mm;overflow:hidden;z-index:999;pointer-events:auto;box-sizing:border-box;background:transparent;touch-action:none}
.pdf-image-editor-box{position:absolute;box-sizing:border-box;border:2px solid #1976ff;cursor:grab;transform:translate(-50%,-50%);transform-origin:center center;touch-action:none;min-width:8mm;min-height:5mm;box-shadow:0 0 0 1px #fff8,0 3px 12px #1976ff33}
.pdf-image-editor-box:active{cursor:grabbing}
.pdf-image-editor-box img{display:block;width:100%;height:100%;object-fit:fill;pointer-events:none;user-select:none;-webkit-user-drag:none}
.pdf-image-editor-box .h{position:absolute;width:13px;height:13px;background:#fff;border:2px solid #1976ff;border-radius:50%;z-index:3;box-sizing:border-box;touch-action:none}
.pdf-image-editor-box .nw{left:-8px;top:-8px;cursor:nwse-resize}.pdf-image-editor-box .n{left:50%;top:-8px;transform:translateX(-50%);cursor:ns-resize}.pdf-image-editor-box .ne{right:-8px;top:-8px;cursor:nesw-resize}.pdf-image-editor-box .e{right:-8px;top:50%;transform:translateY(-50%);cursor:ew-resize}.pdf-image-editor-box .se{right:-8px;bottom:-8px;cursor:nwse-resize}.pdf-image-editor-box .s{left:50%;bottom:-8px;transform:translateX(-50%);cursor:ns-resize}.pdf-image-editor-box .sw{left:-8px;bottom:-8px;cursor:nesw-resize}.pdf-image-editor-box .w{left:-8px;top:50%;transform:translateY(-50%);cursor:ew-resize}
</style><script>(function(){
const frame=document.getElementById('pdfImageEditorFrame'),box=document.getElementById('pdfImageEditorBox');if(!frame||!box)return;
const INIT={x:${safeX},y:${safeY},w:${safeW},h:${safeH},z:${Number(imageZoom)||100}};let state=null;let current=Object.assign({},INIT);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function mm(){const r=frame.getBoundingClientRect();return {r,sx:r.width/210,sy:r.height/297};}
function apply(v){current={x:clamp(Number(v.x)||105,0,210),y:clamp(Number(v.y)||247,0,297),w:clamp(Number(v.w)||24,8,180),h:clamp(Number(v.h)||10,5,250),z:clamp(Number(v.z)||100,50,300)};box.style.width=current.w+'mm';box.style.height=current.h+'mm';box.style.left=current.x+'mm';box.style.top=current.y+'mm';box.style.transform='translate(-50%,-50%) scale('+current.z/100+')';}
function send(){parent.postMessage({type:'pdf-image-editor-change',x:current.x,y:current.y,w:current.w,h:current.h,z:current.z},'*');}
window.addEventListener('message',e=>{if(e.data?.type==='pdf-image-sync')apply(e.data)});
box.addEventListener('wheel',e=>{e.preventDefault();e.stopPropagation();current.z=clamp(current.z+(e.deltaY<0?10:-10),50,300);apply(current);send();},{passive:false});
box.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();const h=[...e.target.classList].find(c=>/^(nw|n|ne|e|se|s|sw|w)$/.test(c))||'';const m=mm();state={mode:h?'resize':'move',handle:h,sx:e.clientX,sy:e.clientY,start:Object.assign({},current),pxX:m.sx,pxY:m.sy};box.setPointerCapture?.(e.pointerId);});
box.addEventListener('pointermove',e=>{if(!state)return;e.preventDefault();const dx=(e.clientX-state.sx)/state.pxX,dy=(e.clientY-state.sy)/state.pxY;let {x,y,w,h,z}=state.start;if(state.mode==='move'){x+=dx;y+=dy;x=clamp(x,w/2,210-w/2);y=clamp(y,h/2,297-h/2);}else{const q=state.handle,L=x-w/2,R=x+w/2,T=y-h/2,B=y+h/2;let l=L,r=R,t=T,b=B;if(q.includes('w'))l=L+dx;if(q.includes('e'))r=R+dx;if(q.includes('n'))t=T+dy;if(q.includes('s'))b=B+dy;w=clamp(r-l,8,180);h=clamp(b-t,5,250);x=(l+r)/2;y=(t+b)/2;x=clamp(x,w/2,210-w/2);y=clamp(y,h/2,297-h/2);}apply({x,y,w,h,z});send();});
function finish(){if(state){send();state=null;}}
box.addEventListener('pointerup',finish);box.addEventListener('pointercancel',finish);box.addEventListener('lostpointercapture',finish);apply(INIT);
})();<\/script>`;
  return html.replace('</body>',script+'</body>');
}
async function loadPDFImageLibrary(){
  try{
    const r=await fetch('/api/pdf-images');
    const d=await r.json();
    if(!r.ok||!d.ok) throw new Error(d.error||'Image Library load failed');
    pdfImageLibrary=d.images||[];
    renderPDFImageLibrary();
  }catch(e){
    const box=$('pdfImageList');
    if(box) box.innerHTML='<div class="history-empty">Image Library load করা যায়নি: '+escHtml(e.message)+'</div>';
  }
}
function escHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderPDFImageLibrary(){
  const box=$('pdfImageList'); if(!box)return;
  $('pdfImageCount').textContent=pdfImageLibrary.length;
  if(!pdfImageLibrary.length){box.innerHTML='<div class="history-empty">কোনো PDF Image নেই।</div>';return;}
  box.innerHTML='';
  pdfImageLibrary.forEach(img=>{
    const item=document.createElement('div'); item.className='pdf-image-item'+(img.id===selectedPDFImageId?' selected':'');
    item.title=img.hasImage?'Click করে Image select করুন':'Click করে Image upload করুন';
    const visual=document.createElement(img.hasImage?'img':'div');
    if(img.hasImage){visual.className='pdf-image-thumb';visual.alt=img.name;visual.src='/api/pdf-images/'+encodeURIComponent(img.id)+'?raw=1&v='+encodeURIComponent(img.updatedAt||Date.now());visual.onerror=()=>{visual.replaceWith(Object.assign(document.createElement('div'),{className:'pdf-image-icon',textContent:'🖼️'}));};}
    else {visual.className='pdf-image-icon';visual.textContent='🖼️';}
    const text=document.createElement('div'); text.className='pdf-image-name'; text.textContent=img.name;
    const state=document.createElement('span'); state.className='pdf-image-state'; state.textContent=img.hasImage?(img.id===selectedPDFImageId?'✓ PDF-তে নির্বাচিত':'PDF-তে বসাতে ক্লিক করুন'):'Click করে Image upload করুন'; text.appendChild(state);
    const check=document.createElement('span'); check.className='pdf-image-check'; check.textContent=img.id===selectedPDFImageId?'✓':'';
    const rename=document.createElement('button'); rename.type='button'; rename.className='pdf-image-rename'; rename.textContent='✏️'; rename.title='Image-এর নাম পরিবর্তন'; rename.onclick=(ev)=>{ev.stopPropagation();renamePDFImage(img);};
    item.append(visual,text,rename,check); item.onclick=()=>selectPDFImage(img); box.appendChild(item);
  });
  const selected=pdfImageLibrary.find(x=>x.id===selectedPDFImageId);
  $('pdfImageSelected').textContent=selected?('Selected: '+selected.name):'কোনো Image নির্বাচিত হয়নি।';
}
async function renamePDFImage(img){
  const next=prompt('নতুন Image / সীল-এর নাম লিখুন:', img?.name||'');
  if(next===null)return;
  const name=next.trim();
  if(!name || name===img.name)return;
  try{
    const r=await fetch('/api/pdf-images/'+encodeURIComponent(img.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||'নাম পরিবর্তন ব্যর্থ');
    const i=pdfImageLibrary.findIndex(x=>x.id===img.id); if(i>=0)pdfImageLibrary[i]=d.image;
    if(selectedPDFImageId===img.id)selectedPDFImageName=d.image.name;
    renderPDFImageLibrary(); status('Image-এর নাম পরিবর্তন হয়েছে।','ok');
  }catch(e){status('Image-এর নাম পরিবর্তন করা যায়নি: '+e.message,'err');}
}

function addPDFImageName(){
  const input=$('pdfImageNameInput'); const name=input?.value.trim();
  if(!name){status('আগে Image-এর নাম লিখুন।','err');return;}
  createOrSelectPDFImage(name);
}
async function createOrSelectPDFImage(name){
  try{
    const existing=pdfImageLibrary.find(x=>x.name===name);
    if(existing){ await selectPDFImage(existing); if(!existing.hasImage) openPDFImageUpload(existing.id); return; }
    const r=await fetch('/api/pdf-images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||'Image name create failed');
    pdfImageLibrary.push(d.image); $('pdfImageNameInput').value=''; renderPDFImageLibrary();
    await selectPDFImage(d.image); openPDFImageUpload(d.image.id);
    status('“'+name+'” তৈরি হয়েছে। এখন Image upload করুন।','ok');
  }catch(e){status('Image name তৈরি করা যায়নি: '+e.message,'err');}
}
async function selectPDFImage(img){
  if(!img)return;
  selectedPDFImageId=img.id; selectedPDFImageName=img.name; selectedPDFImageDataUrl=''; applyPDFImagePreset(img.defaultPosition); pdfBlob=null; if(pdfUrl){URL.revokeObjectURL(pdfUrl);pdfUrl=null;} pdfPreviewNeedsHistorySave=true; renderPDFImageLibrary();
  if(!img.hasImage){ pendingPDFImageId=img.id; openPDFImageUpload(img.id); return; }
  try{
    const r=await fetch('/api/pdf-images/'+encodeURIComponent(img.id)+'?v='+encodeURIComponent(img.updatedAt||Date.now()), {cache:'no-store'}); const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Image পাওয়া যায়নি');
    selectedPDFImageDataUrl=d.dataUrl||''; updatePDFImageAdjustUI(); status('“'+img.name+'” PDF-তে select হয়েছে।','ok');
    if($('certPreview')?.style.display!=='none'){ await previewPDF({skipCharge:true}); }
  }catch(e){selectedPDFImageId='';selectedPDFImageName='';selectedPDFImageDataUrl='';renderPDFImageLibrary();status('Image load ব্যর্থ: '+e.message,'err');}
}
function openPDFImageUpload(id){pendingPDFImageId=id;const input=$('pdfImageFileInput');if(input){input.value='';input.click();}}
async function handlePDFImageUpload(event){
  const file=event.target.files?.[0]; if(!file)return;
  if(!/^image\/(png|jpeg|webp)$/i.test(file.type)){status('শুধু PNG, JPG/JPEG অথবা WEBP image upload করুন।','err');return;}
  if(file.size>12*1024*1024){status('Image সর্বোচ্চ 12 MB হতে পারবে।','err');return;}
  const image=pdfImageLibrary.find(x=>x.id===pendingPDFImageId); if(!image)return;
  try{
    const dataUrl=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(fr.error||new Error('File read failed'));fr.readAsDataURL(file);});
    const r=await fetch('/api/pdf-images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:image.id,name:image.name,dataUrl})});
    const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||'Upload failed');
    const idx=pdfImageLibrary.findIndex(x=>x.id===image.id); if(idx>=0)pdfImageLibrary[idx]=d.image;
    selectedPDFImageId=image.id;selectedPDFImageName=image.name;selectedPDFImageDataUrl=dataUrl;applyPDFImagePreset(d.image.defaultPosition);pendingPDFImageId=''; pdfBlob=null; if(pdfUrl){URL.revokeObjectURL(pdfUrl); pdfUrl=null;} pdfPreviewNeedsHistorySave=true; updatePDFImageAdjustUI(); renderPDFImageLibrary();
    status('“'+image.name+'” Image Server-এ permanently save হয়েছে এবং select হয়েছে।','ok');
    // Immediately show the uploaded image in the already-open certificate preview.
    if($('certPreview')?.style.display!=='none'){ await previewPDF({skipCharge:true}); }
  }catch(e){status('Image upload ব্যর্থ: '+e.message,'err');}
}
async function ensureSelectedPDFImageData(){
  if(!selectedPDFImageId)return '';
  if(selectedPDFImageDataUrl)return selectedPDFImageDataUrl;
  const r=await fetch('/api/pdf-images/'+encodeURIComponent(selectedPDFImageId)+'?v='+Date.now(), {cache:'no-store'}); const d=await r.json();
  if(!r.ok||!d.ok)throw new Error(d.error||'Selected Image পাওয়া যায়নি।');
  selectedPDFImageDataUrl=d.dataUrl||'';return selectedPDFImageDataUrl;
}

function scrollToPdfImage(){const el=document.querySelector('.pdf-image-panel'); if(el){el.scrollIntoView({behavior:'smooth',block:'start'});}}
function scrollToPdfHistory(){const el=document.querySelector('.history-panel'); if(el){el.scrollIntoView({behavior:'smooth',block:'start'});}}
function showRestoredMenuMessage(name){status(name+' option selected.','ok');}
function openPaymentRecharge(){closeSideMenu(); window.open('https://wa.me/8801331167629?text=BDRIS%20Payment%20Recharge','_blank','noopener');}
function openPaymentSupport(){closeSideMenu(); window.open('https://wa.me/8801331167629?text=BDRIS%20Support','_blank','noopener');}
function logoutFromMenu(){closeSideMenu(); localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem('BDRIS_ACCESS_TOKEN'); location.reload();}
function toggleSideMenu(){
  const bar=document.querySelector('.side-bar'), back=document.getElementById('sideMenuBackdrop');
  if(!bar||!back)return;
  const open=!bar.classList.contains('open');
  bar.classList.toggle('open',open); back.classList.toggle('open',open);
  document.body.classList.toggle('side-menu-open',open);
}
function closeSideMenu(){
  const bar=document.querySelector('.side-bar'), back=document.getElementById('sideMenuBackdrop');
  if(bar)bar.classList.remove('open'); if(back)back.classList.remove('open'); document.body.classList.remove('side-menu-open');
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSideMenu()});

async function loadPDFImageLibrary(){
  try{
    const r=await fetch('/api/pdf-images');
    const d=await r.json();
    if(!r.ok||!d.ok) throw new Error(d.error||'Image Library load failed');
    pdfImageLibrary=d.images||[];
    renderPDFImageLibrary();
  }catch(e){
    const box=$('pdfImageList');
    if(box) box.innerHTML='<div class="history-empty">Image Library load করা যায়নি: '+escHtml(e.message)+'</div>';
  }
}
function escHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderPDFImageLibrary(){
  const box=$('pdfImageList'); if(!box)return;
  $('pdfImageCount').textContent=pdfImageLibrary.length;
  if(!pdfImageLibrary.length){box.innerHTML='<div class="history-empty">কোনো PDF Image নেই।</div>';return;}
  box.innerHTML='';
  pdfImageLibrary.forEach(img=>{
    const item=document.createElement('div'); item.className='pdf-image-item'+(img.id===selectedPDFImageId?' selected':'');
    item.title=img.hasImage?'Click করে Image select করুন':'Click করে Image upload করুন';
    const visual=document.createElement(img.hasImage?'img':'div');
    if(img.hasImage){visual.className='pdf-image-thumb';visual.alt=img.name;visual.src='/api/pdf-images/'+encodeURIComponent(img.id)+'?raw=1&v='+encodeURIComponent(img.updatedAt||Date.now());visual.onerror=()=>{visual.replaceWith(Object.assign(document.createElement('div'),{className:'pdf-image-icon',textContent:'🖼️'}));};}
    else {visual.className='pdf-image-icon';visual.textContent='🖼️';}
    const text=document.createElement('div'); text.className='pdf-image-name'; text.textContent=img.name;
    const state=document.createElement('span'); state.className='pdf-image-state'; state.textContent=img.hasImage?(img.id===selectedPDFImageId?'✓ PDF-তে নির্বাচিত':'PDF-তে বসাতে ক্লিক করুন'):'Click করে Image upload করুন'; text.appendChild(state);
    const check=document.createElement('span'); check.className='pdf-image-check'; check.textContent=img.id===selectedPDFImageId?'✓':'';
    const rename=document.createElement('button'); rename.type='button'; rename.className='pdf-image-rename'; rename.textContent='✏️'; rename.title='Image-এর নাম পরিবর্তন'; rename.onclick=(ev)=>{ev.stopPropagation();renamePDFImage(img);};
    item.append(visual,text,rename,check); item.onclick=()=>selectPDFImage(img); box.appendChild(item);
  });
  const selected=pdfImageLibrary.find(x=>x.id===selectedPDFImageId);
  $('pdfImageSelected').textContent=selected?('Selected: '+selected.name):'কোনো Image নির্বাচিত হয়নি।';
}
async function renamePDFImage(img){
  const next=prompt('নতুন Image / সীল-এর নাম লিখুন:', img?.name||'');
  if(next===null)return;
  const name=next.trim();
  if(!name || name===img.name)return;
  try{
    const r=await fetch('/api/pdf-images/'+encodeURIComponent(img.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||'নাম পরিবর্তন ব্যর্থ');
    const i=pdfImageLibrary.findIndex(x=>x.id===img.id); if(i>=0)pdfImageLibrary[i]=d.image;
    if(selectedPDFImageId===img.id)selectedPDFImageName=d.image.name;
    renderPDFImageLibrary(); status('Image-এর নাম পরিবর্তন হয়েছে।','ok');
  }catch(e){status('Image-এর নাম পরিবর্তন করা যায়নি: '+e.message,'err');}
}

function addPDFImageName(){
  const input=$('pdfImageNameInput'); const name=input?.value.trim();
  if(!name){status('আগে Image-এর নাম লিখুন।','err');return;}
  createOrSelectPDFImage(name);
}
async function createOrSelectPDFImage(name){
  try{
    const existing=pdfImageLibrary.find(x=>x.name===name);
    if(existing){ await selectPDFImage(existing); if(!existing.hasImage) openPDFImageUpload(existing.id); return; }
    const r=await fetch('/api/pdf-images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||'Image name create failed');
    pdfImageLibrary.push(d.image); $('pdfImageNameInput').value=''; renderPDFImageLibrary();
    await selectPDFImage(d.image); openPDFImageUpload(d.image.id);
    status('“'+name+'” তৈরি হয়েছে। এখন Image upload করুন।','ok');
  }catch(e){status('Image name তৈরি করা যায়নি: '+e.message,'err');}
}
async function selectPDFImage(img){
  if(!img)return;
  selectedPDFImageId=img.id; selectedPDFImageName=img.name; selectedPDFImageDataUrl=''; pdfBlob=null; if(pdfUrl){URL.revokeObjectURL(pdfUrl);pdfUrl=null;} pdfPreviewNeedsHistorySave=true; renderPDFImageLibrary();
  if(!img.hasImage){ pendingPDFImageId=img.id; openPDFImageUpload(img.id); return; }
  try{
    const r=await fetch('/api/pdf-images/'+encodeURIComponent(img.id)+'?v='+encodeURIComponent(img.updatedAt||Date.now()), {cache:'no-store'}); const d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Image পাওয়া যায়নি');
    selectedPDFImageDataUrl=d.dataUrl||''; updatePDFImageAdjustUI(); status('“'+img.name+'” PDF-তে select হয়েছে।','ok');
    if($('certPreview')?.style.display!=='none'){ await previewPDF({skipCharge:true}); }
  }catch(e){selectedPDFImageId='';selectedPDFImageName='';selectedPDFImageDataUrl='';renderPDFImageLibrary();status('Image load ব্যর্থ: '+e.message,'err');}
}
function openPDFImageUpload(id){pendingPDFImageId=id;const input=$('pdfImageFileInput');if(input){input.value='';input.click();}}
async function handlePDFImageUpload(event){
  const file=event.target.files?.[0]; if(!file)return;
  if(!/^image\/(png|jpeg|webp)$/i.test(file.type)){status('শুধু PNG, JPG/JPEG অথবা WEBP image upload করুন।','err');return;}
  if(file.size>12*1024*1024){status('Image সর্বোচ্চ 12 MB হতে পারবে।','err');return;}
  const image=pdfImageLibrary.find(x=>x.id===pendingPDFImageId); if(!image)return;
  try{
    const dataUrl=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(fr.error||new Error('File read failed'));fr.readAsDataURL(file);});
    const r=await fetch('/api/pdf-images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:image.id,name:image.name,dataUrl})});
    const d=await r.json(); if(!r.ok||!d.ok)throw new Error(d.error||'Upload failed');
    const idx=pdfImageLibrary.findIndex(x=>x.id===image.id); if(idx>=0)pdfImageLibrary[idx]=d.image;
    selectedPDFImageId=image.id;selectedPDFImageName=image.name;selectedPDFImageDataUrl=dataUrl;pendingPDFImageId=''; pdfBlob=null; if(pdfUrl){URL.revokeObjectURL(pdfUrl); pdfUrl=null;} pdfPreviewNeedsHistorySave=true; updatePDFImageAdjustUI(); renderPDFImageLibrary();
    status('“'+image.name+'” Image Server-এ permanently save হয়েছে এবং select হয়েছে।','ok');
    // Immediately show the uploaded image in the already-open certificate preview.
    if($('certPreview')?.style.display!=='none'){ await previewPDF({skipCharge:true}); }
  }catch(e){status('Image upload ব্যর্থ: '+e.message,'err');}
}
async function ensureSelectedPDFImageData(){
  if(!selectedPDFImageId)return '';
  if(selectedPDFImageDataUrl)return selectedPDFImageDataUrl;
  const r=await fetch('/api/pdf-images/'+encodeURIComponent(selectedPDFImageId)+'?v='+Date.now(), {cache:'no-store'}); const d=await r.json();
  if(!r.ok||!d.ok)throw new Error(d.error||'Selected Image পাওয়া যায়নি।');
  selectedPDFImageDataUrl=d.dataUrl||'';return selectedPDFImageDataUrl;
}

function status(text, type = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + type;
}

function capitalizeCase(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function formatDateDDMMYYYY(value) {
  if (!value) return "";
  const text = String(value).trim();
  let day, month, year, match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (match) [year, month, day] = match.slice(1).map(Number);
  if (!match) {
    match = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (match) [day, month, year] = match.slice(1).map(Number);
  }
  if (!match) {
    match = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (match) {
      const months = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
      day = Number(match[1]); month = months[match[2].toLowerCase()]; year = Number(match[3]);
    }
  }
  if (!day || !month || !year || month < 1 || month > 12 || day < 1 || day > 31) return text;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return text;
  return `${String(day).padStart(2,"0")}/${String(month).padStart(2,"0")}/${year}`;
}

function numberToWords(number) {
  number = Number(number);
  const ones = ["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  if (number < 20) return ones[number];
  if (number < 100) return tens[Math.floor(number / 10)] + (number % 10 ? " " + ones[number % 10] : "");
  if (number < 1000) return ones[Math.floor(number / 100)] + " Hundred" + (number % 100 ? " " + numberToWords(number % 100) : "");
  if (number < 1000000) return numberToWords(Math.floor(number / 1000)) + " Thousand" + (number % 1000 ? " " + numberToWords(number % 1000) : "");
  return String(number);
}

function ordinalDay(day) {
  const days = ["","First","Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth","Ninth","Tenth","Eleventh","Twelfth","Thirteenth","Fourteenth","Fifteenth","Sixteenth","Seventeenth","Eighteenth","Nineteenth","Twentieth","Twenty First","Twenty Second","Twenty Third","Twenty Fourth","Twenty Fifth","Twenty Sixth","Twenty Seventh","Twenty Eighth","Twenty Ninth","Thirtieth","Thirty First"];
  return days[day] || "";
}

function yearToInWord(year) {
  year = Number(year);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return String(year);
  if (year >= 1000 && year < 2000) {
    const first = numberToWords(Math.floor(year / 100));
    const last = year % 100;
    return last ? `${first} ${numberToWords(last)}` : `${first} Hundred`;
  }
  if (year >= 2000 && year < 2100) {
    const rest = year % 100;
    return rest ? `Two Thousand ${numberToWords(rest)}` : `Two Thousand`;
  }
  return numberToWords(year);
}

function dateToInWord(value) {
  const match = formatDateDDMMYYYY(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const months = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${ordinalDay(Number(match[1]))} of ${months[Number(match[2])]} ${yearToInWord(Number(match[3]))}`;
}

function addBangladeshBn(value) {
  const text = String(value || "").trim();
  return !text ? "বাংলাদেশ" : text.includes("বাংলাদেশ") ? text : `${text}, বাংলাদেশ`;
}

function addBangladeshEn(value) {
  const text = capitalizeCase(value);
  return !text ? "Bangladesh" : text.toLowerCase().includes("bangladesh") ? text : `${text}, Bangladesh`;
}

function getNormalized(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g, "");
}

function resolveGeoParentsForAutoFill(data, fields){
  try{
    if(typeof geoExtractAddress!=='function') return data;
    const sourceParts=[];
    for(const item of (Array.isArray(fields)?fields:[])){
      sourceParts.push(String(item?.label||''), String(item?.value||''), String(item?.englishLabel||''), String(item?.englishValue||''));
    }
    sourceParts.push(String(data?.pobBn||''), String(data?.pobEn||''));
    const raw=sourceParts.filter(Boolean).join('\n');
    if(!raw) return data;
    const parsed=geoExtractAddress(raw);
    let district=parsed?.district||'';
    let upazila=parsed?.upazila||'';
    let union=parsed?.union||'';

    // If only an upazila is visible, resolve its parent district from Geo Data.
    let districtObj=geoFindDistrict(district);
    if(!districtObj && upazila){
      const hits=[];
      for(const d0 of (ADDRESS_GEO_DATA?.districts||[])){
        const u0=geoFindUpazila(upazila,d0);
        if(u0) hits.push([d0,u0]);
      }
      if(hits.length===1){ districtObj=hits[0][0]; upazila=hits[0][1].bn; }
    }

    // If only a union is visible, resolve it inside the known district/upazila.
    if(!districtObj && union){
      const hits=[];
      for(const d0 of (ADDRESS_GEO_DATA?.districts||[])){
        for(const u0 of (d0.upazilas||[])){
          const un0=geoFindUnion(union,u0);
          if(un0) hits.push([d0,u0,un0]);
        }
      }
      if(hits.length===1){ districtObj=hits[0][0]; upazila=hits[0][1].bn; union=hits[0][2].bn; }
    } else if(districtObj && union && !upazila){
      for(const u0 of (districtObj.upazilas||[])){
        const un0=geoFindUnion(union,u0);
        if(un0){ upazila=u0.bn; union=un0.bn; break; }
      }
    }

    if(districtObj) district=districtObj.bn;
    // Never invent an unrelated first upazila. Only fill what Geo Data can resolve.
    if(!data.upazilaPouroshavaUnion && (upazila||district)){
      data.upazilaPouroshavaUnion=[upazila,district].filter(Boolean).join(' ').trim();
    }
    if(!data.pobBn && (parsed?.villageBn||parsed?.postOfficeBn||district||upazila||union)){
      const parts=[parsed?.villageBn, parsed?.postOfficeBn, upazila, district].filter(Boolean);
      if(parts.length) data.pobBn=parts.join(', ');
    }
    if(!data.pobEn && (parsed?.villageEn||parsed?.postOfficeEn||upazila||district||union)){
      const parts=[parsed?.villageEn, parsed?.postOfficeEn, upazila, district].filter(Boolean);
      if(parts.length) data.pobEn=parts.join(', ');
    }
    return data;
  }catch(_){ return data; }
}

async function fill(d) {
  // Never let an unresolved Promise leak into an input as "[object Promise]".
  d = await Promise.resolve(d);
  const fields = Array.isArray(d?.allFields) ? await Promise.all(d.allFields.map(async item => ({
    ...item,
    value: await Promise.resolve(item?.value ?? ""),
    englishValue: await Promise.resolve(item?.englishValue ?? "")
  }))) : [];
  function findRow(...labels) {
    const wanted = labels.map(getNormalized).filter(Boolean);
    return fields.find(item => wanted.includes(getNormalized(item?.label)) || wanted.includes(getNormalized(item?.englishLabel))) || null;
  }
  const rowValueBn = (...labels) => findRow(...labels)?.value || "";
  const rowValueEn = (...labels) => findRow(...labels)?.englishValue || findRow(...labels)?.value || "";
  const dob = formatDateDDMMYYYY(d?.dob || "");
  d = resolveGeoParentsForAutoFill(d, fields) || d;
  const resolved = {};
  for (const [key, value] of Object.entries(d || {})) {
    resolved[key] = await Promise.resolve(value);
  }
  const values = {
    in_nameBn: resolved?.nameBn || rowValueBn("নিবন্ধিত ব্যক্তির নাম"),
    in_nameEn: capitalizeCase(resolved?.nameEn || rowValueEn("registered person name")),
    in_dob: registrationMode === 'death' ? '' : dob, in_birthDate: dob, in_sex: capitalizeCase(resolved?.sex || ""), in_inWord: registrationMode === 'death' ? dateToInWord(formatDateDDMMYYYY($('in_dob')?.value || '')) : dateToInWord(dob),
    in_brn: resolved?.brn || "", in_regDate: formatDateDDMMYYYY(resolved?.regDate || ""),
    in_issuanceDate: formatDateDDMMYYYY(resolved?.issuanceDate || ""),
    in_registrationOffice: capitalizeCase(resolved?.registrationOffice || ""),
    in_upazilaPouroshavaUnion: capitalizeCase(resolved?.upazilaPouroshavaUnion || ""),
    in_fatherBn: resolved?.fatherBn || rowValueBn("পিতার নাম"),
    in_fatherEn: capitalizeCase(resolved?.fatherEn || rowValueEn("Father's Name")),
    in_fatherNationalityBn: resolved?.fatherNationalityBn || rowValueBn("পিতার জাতীয়তা", "পিতার জাতীয়তা"),
    in_fatherNationalityEn: capitalizeCase(resolved?.fatherNationalityEn || rowValueEn("Father's Nationality")),
    in_motherBn: resolved?.motherBn || rowValueBn("মাতার নাম"),
    in_motherEn: capitalizeCase(resolved?.motherEn || rowValueEn("Mother's Name")),
    in_motherNationalityBn: resolved?.motherNationalityBn || rowValueBn("মাতার জাতীয়তা", "মাতার জাতীয়তা"),
    in_motherNationalityEn: capitalizeCase(resolved?.motherNationalityEn || rowValueEn("Mother's Nationality")),
    in_pobBn: addBangladeshBn(resolved?.pobBn || rowValueBn("জন্মস্থান")),
    in_pobEn: addBangladeshEn(resolved?.pobEn || rowValueEn("Place of Birth")),
    in_addrBn: resolved?.addrBn || "", in_addrEn: capitalizeCase(resolved?.addrEn || "")
  };
  for (const [id, value] of Object.entries(values)) {
    const input = $(id);
    if (input) input.value = value;
  }
  currentData = d;
  generateQRForCertificate().catch(() => {});
  renderAll(fields);
}
function renderAll(items){
 const box=$("allFields");
 const count=$("count");
 // The newer sidebar UI intentionally removed the legacy "allFields" panel.
 // Auto Fill must still complete successfully when that optional panel is absent.
 if(!box){
   if(count) count.textContent=items.length;
   return;
 }
 box.innerHTML="";
 if(count) count.textContent=items.length;
 if(!items.length){box.innerHTML='<div class="item">কোনো অতিরিক্ত field পাওয়া যায়নি।</div>';return}
 for(const x of items){const div=document.createElement("div");div.className="item";div.innerHTML='<b>'+esc(x.label)+(x.englishLabel?' <span class="small">/ '+esc(x.englishLabel)+'</span>':'')+'</b><span>'+esc(x.value)+(x.englishValue?'\n'+esc(x.englishValue):'')+'</span>';box.appendChild(div)}
}

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function imageDataUrl(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Asset load failed: ${path}`);
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Asset read failed"));
    reader.readAsDataURL(blob);
  });
}

// Bundle the Bengali fonts into the generated PDF HTML so PDF output does not
// depend on which fonts are installed on the user's PC.
async function fontDataUrl(path) {
  return await imageDataUrl(path);
}

async function cropImageDataUrl(sourceUrl, x, y, width, height) {
  const image = new Image();
  image.src = sourceUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * width);
  canvas.height = Math.round(image.naturalHeight * height);
  canvas.getContext("2d").drawImage(
    image,
    Math.round(image.naturalWidth * x), Math.round(image.naturalHeight * y),
    canvas.width, canvas.height, 0, 0, canvas.width, canvas.height
  );
  return canvas.toDataURL("image/jpeg", 0.95);
}


function setQRStatus(text, type = "") {
  const el = $("qrStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = type === "err" ? "#9b1c1c" : type === "ok" ? "#176b35" : "#68737e";
}

function generateQRImage(link) {
  return new Promise((resolve, reject) => {
    if (!link) return reject(new Error("QR Link দিন।"));
    fetch("/api/qr", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({text: link})
    })
    .then(async r => {
      let data = null;
      try { data = await r.json(); } catch (_) {}
      if (!r.ok || !data?.ok || !data?.dataUrl) {
        throw new Error(data?.error || `QR server error: HTTP ${r.status}`);
      }
      resolve(data.dataUrl);
    })
    .catch(reject);
  });
}
function getAutoQRLink() {
  const d = currentData || {};
  const candidates = [
    d.qrLink, d.qrUrl, d.verificationUrl, d.verifyUrl,
    d.certificateUrl, d.certificateVerifyUrl, d.verifyLink
  ];
  const found = candidates.find(v => typeof v === "string" && v.trim());
  if (found) return found.trim();

  // Only use the exact verification URL returned by BDRIS/eVerify.
  // Do not generate a QR to the generic search page because that would not
  // represent the currently auto-filled certificate record.
  return "";
}

async function generateQRForCertificate() {
  const link = getAutoQRLink();
  currentQRLabel = getQRLabelFromData(link);
  if (!link) {
    currentQRImage = "";
    setQRStatus("এই রেকর্ডের নির্দিষ্ট BDRIS verification QR পাওয়া যায়নি। PDF-তে আলাদা QR বসানো হবে না।", "err");
    return;
  }
  try {
    const img = await generateQRImage(link);
    currentQRImage = img;
    const holder = $("qrPreview");
    if (holder) {
      holder.innerHTML = "";
      const image = document.createElement("img");
      image.src = img;
      image.alt = "QR Code";
      image.style.width = "180px";
      image.style.height = "180px";
      image.style.objectFit = "contain";
      holder.appendChild(image);
    }
    setQRStatus("QR eVerify verification link-এর সাথে যুক্ত হয়েছে।", "ok");
  } catch (e) {
    currentQRImage = "";
    setQRStatus(e.message || "QR তৈরি করা যায়নি।", "err");
  }
}
function handleDeathCauseSelect(lang){
  // Death-cause selection is driven by the Bengali dropdown only.
  const bnSelect=$('in_deathCauseBnSelect'), bnArea=$('in_deathCauseBn');
  const enSelect=$('in_deathCauseEnSelect'), enArea=$('in_deathCauseEn');
  if(!bnSelect||!bnArea||!enArea)return;
  if(bnSelect.value==='manual'){
    bnArea.style.display='block';
    enArea.style.display='block';
    bnArea.value='';
    enArea.value='';
    bnArea.focus();
  } else if(bnSelect.value){
    const opt=bnSelect.options[bnSelect.selectedIndex];
    bnArea.value=opt?.textContent?.trim() || '';
    const enOpt=[...enSelect.options].find(o=>o.value===bnSelect.value);
    enArea.value=enOpt?.textContent?.trim() || '';
    bnArea.style.display='none';
    enArea.style.display='none';
  } else {
    bnArea.value=''; enArea.value='';
    bnArea.style.display='none'; enArea.style.display='none';
  }
  if(typeof pdfPreviewNeedsHistorySave!=='undefined') pdfPreviewNeedsHistorySave=true;
}
function syncDeathCauseSelectors(){
  const bnArea=$('in_deathCauseBn'), enArea=$('in_deathCauseEn'), bnSelect=$('in_deathCauseBnSelect'), enSelect=$('in_deathCauseEnSelect');
  if(!bnArea||!enArea||!bnSelect||!enSelect)return;
  const value=bnArea.value.trim();
  const opt=[...bnSelect.options].find(o=>o.textContent.trim()===value);
  if(opt){
    bnSelect.value=opt.value;
    const enOpt=[...enSelect.options].find(o=>o.value===opt.value);
    enArea.value=enOpt?.textContent?.trim() || '';
    bnArea.style.display='none'; enArea.style.display='none';
  } else if(value || enArea.value.trim()) {
    bnSelect.value='manual';
    bnArea.style.display='block'; enArea.style.display='block';
  } else {
    bnSelect.value=''; enArea.value='';
    bnArea.style.display='none'; enArea.style.display='none';
  }
}

function setRegistrationMode(mode) {
  registrationMode = mode === 'death' ? 'death' : 'birth';
  const death = registrationMode === 'death';
  const dateLabel = $('dateFieldLabel');
  if (dateLabel) dateLabel.textContent = death ? 'মৃত্যুর তারিখ' : 'জন্ম তারিখ';
  const addrBn = $('addrBnField'), addrEn = $('addrEnField');
  const causeBn = $('deathCauseBnField'), causeEn = $('deathCauseEnField');
  if (addrBn) addrBn.style.display = death ? 'none' : '';
  if (addrEn) addrEn.style.display = death ? 'none' : '';
  if (causeBn) causeBn.style.display = death ? '' : 'none';
  if (causeEn) causeEn.style.display = death ? '' : 'none';
  const dob = $('in_dob');
  const birthDate = $('in_birthDate');
  const inWord = $('in_inWord');
  if (death) {
    if (birthDate && !birthDate.value && currentData?.dob) birthDate.value = formatDateDDMMYYYY(currentData.dob);
    if (dob) { dob.value = ''; dob.placeholder = 'মৃত্যুর তারিখ (DD/MM/YYYY বা YYYY-MM-DD)'; }
    if (inWord) { inWord.readOnly = true; inWord.value = ''; inWord.placeholder = 'মৃত্যুর তারিখ দিলে অটো In Word হবে'; }
    syncDeathCauseSelectors();
  } else {
    if (dob && birthDate?.value) dob.value = birthDate.value;
    if (inWord) { inWord.readOnly = true; inWord.value = dateToInWord(formatDateDDMMYYYY(dob?.value || '')); inWord.placeholder = ''; }
  }
  document.body.classList.toggle('death-registration-mode', death);
  if (dob) dob.dispatchEvent(new Event('input', {bubbles:true}));
  closeSideMenu();
  status(death ? 'মৃত্যু নিবন্ধন মেইক চালু হয়েছে। মৃত্যুর তারিখের In Word ম্যানুয়ালি লিখুন।' : 'জন্ম নিবন্ধন মেইক চালু হয়েছে।', 'ok');
}

function setCertificateType(type) {
  certificateType = type || 'new';
  const buttons = {new:$('typeNewBtn'), corrected:$('typeCorrectedBtn'), duplicate:$('typeDuplicateBtn')};
  Object.values(buttons).forEach(b => b && b.classList.remove('active'));
  if (buttons[certificateType]) buttons[certificateType].classList.add('active');
}

function changeBengaliFont() {
  const select = $('font-selector');
  selectedBengaliFont = select ? select.value : 'NikoshLight';
  const family = {
    NikoshLight: "'NikoshLight','Nikosh','Noto Serif Bengali',serif",
    SolaimanLipi: "'SolaimanLipi','Siyam Rupali','Noto Serif Bengali',sans-serif",
    SutonnyOMJ: "'SutonnyOMJ','SutonnyMJ','Noto Serif Bengali',serif"
  }[selectedBengaliFont] || "'Noto Serif Bengali',serif";
  document.querySelectorAll('#in_nameBn,#in_fatherBn,#in_motherBn,#in_fatherNationalityBn,#in_motherNationalityBn,#in_pobBn,#in_addrBn').forEach(el => {el.style.fontFamily=family;el.style.fontWeight='400';});
}

function scrollToFieldSection(section){
  const map={personal:'in_nameBn',father:'in_fatherBn',mother:'in_motherBn',address:'in_addrBn'};
  const el=$(map[section]);
  const target=el?.closest('label') || el;
  if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); setTimeout(()=>el?.focus({preventScroll:true}),350); }
}

function clearForm(){
 document.querySelectorAll("input,textarea").forEach(x=>x.value="");
 renderAll([]);
 $("captchaArea").style.display = "none";
 $("certPreview").style.display = "none";
 currentSessionId = null;
 currentData = null;
 currentQRImage = "";
 selectedPDFImageId = "";
 selectedPDFImageName = "";
 selectedPDFImageDataUrl = "";
 $('in_deathCauseBn') && ($('in_deathCauseBn').value=''); $('in_deathCauseEn') && ($('in_deathCauseEn').value=''); $('in_deathCauseBnSelect') && ($('in_deathCauseBnSelect').value=''); $('in_deathCauseEnSelect') && ($('in_deathCauseEnSelect').value=''); $('in_deathCauseBn') && ($('in_deathCauseBn').style.display='none'); $('in_deathCauseEn') && ($('in_deathCauseEn').style.display='none');
 setRegistrationMode('birth');
 imagePositionX = 105; imagePositionY = 247; imageZoom = 100; imageWidth = 24; imageHeight = 10;
 updatePDFImageAdjustUI();
 renderPDFImageLibrary();
 if ($("qrLink")) $("qrLink").value = "";
 setQRStatus("");
 pdfBlob = null;
 status("Cleared.")
}

function bengaliDigits(value){
  return String(value ?? '').replace(/[0-9]/g, d => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

function normalizeMathNumber(value){
  return String(value ?? '').replace(/[০-৯]/g, d => '0123456789'['০১২৩৪৫৬৭৮৯'.indexOf(d)]);
}

function calculateCaptchaExpression(value){
  const expr = normalizeMathNumber(value).replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
  const m = expr.match(/^([0-9]+)([+\-])([0-9]+)$/);
  if(!m) return null;
  const a = Number(m[1]), b = Number(m[3]);
  if(!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const result = m[2] === '+' ? a + b : a - b;
  return Number.isSafeInteger(result) ? result : null;
}

function parseMathExpression(value){
  const expr=normalizeMathNumber(value).replace(/\s+/g,'');
  const m=expr.match(/^(\d+)\s*([+\-])\s*(\d+)$/);
  if(!m) return null;
  const a=Number(m[1]), b=Number(m[3]);
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)) return null;
  return {a,b,op:m[2],result:m[2]==='+'?a+b:a-b};
}

function getMathInput(){ return $('in_captcha_code'); }

function updateCaptchaMathResult(){
  const input=getMathInput();
  const out=$('mathCaptchaConverted');
  if(!input||!out) return;
  const parsed=parseMathExpression(input.value);
  out.className='math-captcha-converted inline-math-hint';
  out.textContent=parsed
    ? `${bengaliDigits(parsed.a)} ${parsed.op} ${bengaliDigits(parsed.b)} = ? — এখন “=” চাপুন।`
    : 'এই একই ক্যাপচা ঘরেই হিসাব লিখুন। যেমন: 64+35 বা 64-35';
}

function appendMathOperator(op){
  const input=getMathInput();
  if(!input) return;
  let current=normalizeMathNumber(input.value).replace(/[^0-9+\-]/g,'');
  if(input.dataset.resultShown==='1'){
    input.value='';
    input.dataset.resultShown='';
    current='';
  }
  if(!current) return;
  if(/[+\-]$/.test(current)) current=current.slice(0,-1)+op;
  else current+=op;
  input.value=current;
  updateCaptchaMathResult();
  input.focus();
  try{ input.setSelectionRange(input.value.length,input.value.length); }catch(e){}
}

function showMathResult(){
  const input=getMathInput();
  const out=$('mathCaptchaConverted');
  if(!input) return;
  const parsed=parseMathExpression(input.value);
  if(!parsed){
    if(out){out.className='math-captcha-converted inline-math-hint err';out.textContent='সঠিক হিসাব লিখুন। যেমন: 64+35 অথবা 64-35';}
    input.focus();
    return;
  }
  // The existing CAPTCHA input itself becomes the result. No second input is used.
  input.value=String(parsed.result);
  input.dataset.resultShown='1';
  if(out){out.className='math-captcha-converted inline-math-hint ok';out.textContent=`ফলাফল: ${bengaliDigits(parsed.result)} — একই ঘরে ফল দেখানো হয়েছে।`; }
  input.focus();
  try{ input.setSelectionRange(input.value.length,input.value.length); }catch(e){}
}

function toggleMathCalculator(){
  const tools=$('inlineCalcTools');
  const btn=$('mathCalcToggle');
  const input=getMathInput();
  if(!tools || !input) return;

  // When the SAME captcha box already contains a complete calculation,
  // the calculator icon itself acts as the result button.
  const parsed=parseMathExpression(input.value);
  if(parsed){
    showMathResult();
    tools.hidden=true;
    if(btn){btn.setAttribute('aria-expanded','false');btn.classList.remove('active');}
    input.placeholder='ক্যাপচা কোড লিখুন';
    return;
  }

  const willOpen=tools.hidden;
  tools.hidden=!willOpen;
  if(btn){btn.setAttribute('aria-expanded',String(willOpen));btn.classList.toggle('active',willOpen);}
  input.placeholder=willOpen ? 'একই ঘরে হিসাব লিখুন: 64+35' : 'ক্যাপচা কোড লিখুন';
  if(willOpen){input.focus();updateCaptchaMathResult();}
}
function clearMathCalculator(){
  const input=getMathInput(), out=$('mathCaptchaConverted');
  if(input){input.value='';input.dataset.resultShown='';input.placeholder='একই ঘরে হিসাব লিখুন: 64+35';input.focus();}
  if(out){out.className='math-captcha-converted inline-math-hint';out.textContent='এই একই ঘরেই হিসাব লিখুন। যেমন: 64+35 বা 64-35';}
}
function newMathCaptcha(){ clearMathCalculator(); }
function convertMathAnswer(){ showMathResult(); }

document.addEventListener('DOMContentLoaded', () => {
  const mathInput = $('in_captcha_code');
  if(mathInput) mathInput.addEventListener('input', () => {
    mathInput.dataset.resultShown='';
    if($('inlineCalcTools') && !$('inlineCalcTools').hidden) updateCaptchaMathResult();
  });
});

async function fetchCaptcha(){
  const brn = $("search_brn").value.trim();
  const dob = normalizeDate($("search_dob").value);
  
  if(!brn || !dob) {
    status("সঠিক জন্ম তারিখ দিন: YYYY-MM-DD বা DD/MM/YYYY।", "err");
    return;
  }

  $("search_dob").value = dob;
  
  status("BDRIS থেকে ক্যাপচা আনা হচ্ছে...");
  
  try {
    const r = await fetch("/api/init-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brn, dob })
    });
    const j = await r.json();
    
    if(!j.ok) {
      status("Error: " + j.error, "err");
      return;
    }
    
    currentSessionId = j.sessionId;
    $("img_captcha").src = j.captchaImage;
    $("captchaArea").style.display = "block";
    newMathCaptcha();
    status("ক্যাপচা লোড হয়েছে। কোডটি দেখে সাবমিট করুন।", "ok");
    
  } catch(e) {
    status("Server Connection Error! সার্ভার কি চালু করা আছে?", "err");
  }
}

function normalizeDate(value){
  const parts = String(value || "").trim().split(/[\/-]/).map(Number);
  if(parts.length !== 3 || parts.some(Number.isNaN)) return "";

  let year, month, day;
  if(parts[0] >= 1000){
    [year, month, day] = parts;
  }else{
    [day, month, year] = parts;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if(date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year.toString().padStart(4,"0")}-${month.toString().padStart(2,"0")}-${day.toString().padStart(2,"0")}`;
}

async function submitCaptcha(){
  const captcha = $("in_captcha_code").value.trim();
  if(!captcha) {
    status("ক্যাপচা কোড টাইপ করুন।", "err");
    return;
  }
  status("তথ্য সংগ্রহ করা হচ্ছে...");
  
  try {
    const r = await fetch("/api/submit-captcha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, captcha })
    });
    const j = await r.json();
    
    if(!j.ok) {
      status("Error: " + j.error, "err");
      return;
    }
    
    await fill(j.data);
    $("captchaArea").style.display = "none";
    status("Success: তথ্য সফলভাবে Auto Fill হয়েছে!", "ok");
    
  } catch(e) {
    status("Server Connection Error: " + e.message, "err");
  }
}

// PDF History: IndexedDB is used so generated PDF blobs survive page refresh/restart.
function openPDFHistoryDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(getPDFHistoryDBName(), 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PDF_HISTORY_STORE)) {
        const store = db.createObjectStore(PDF_HISTORY_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('PDF History database খুলতে ব্যর্থ।'));
  });
}

function getPDFHistory() {
  return openPDFHistoryDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_HISTORY_STORE, 'readonly');
    const req = tx.objectStore(PDF_HISTORY_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a,b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  }));
}

function putPDFHistory(record) {
  return openPDFHistoryDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_HISTORY_STORE, 'readwrite');
    tx.objectStore(PDF_HISTORY_STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
}

function deletePDFHistory(id) {
  return openPDFHistoryDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_HISTORY_STORE, 'readwrite');
    tx.objectStore(PDF_HISTORY_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
}

function collectPDFFormData() {
  const data = {};
  PDF_FIELD_IDS.forEach(id => { const el = $(id); if (el) data[id] = el.value; });
  return data;
}

function applyPDFFormData(data) {
  PDF_FIELD_IDS.forEach(id => { const el = $(id); if (el) el.value = data?.[id] ?? ''; });
}

function historyDisplayName(data) {
  return data?.in_nameBn || data?.in_nameEn || data?.in_brn || 'Birth Certificate';
}

function formatHistoryDate(ts) {
  try { return new Date(ts).toLocaleString('bn-BD'); } catch (_) { return new Date(ts).toLocaleString(); }
}

async function saveCurrentPDFToHistory() {
  if (!pdfBlob || !pdfBlob.size) return;
  const formData = collectPDFFormData();
  const id = editingHistoryId || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9));
  const record = {
    id,
    createdAt: Date.now(),
    data: formData,
    certificateType,
    registrationMode,
    selectedBengaliFont,
    currentData: currentData || null,
    qrImage: currentQRImage || '',
    qrLabel: currentQRLabel || '',
    selectedPDFImageId: selectedPDFImageId || '',
    selectedPDFImageName: selectedPDFImageName || '',
    imagePositionX,
    imagePositionY,
    imageZoom,
    imageWidth,
    imageHeight,
    imageCoordinateMode:'page-mm',
    pdfBlob
  };
  await putPDFHistory(record);
  editingHistoryId = null;
  await renderPDFHistory();
}

async function editPDFHistory(id) {
  try {
    const records = await getPDFHistory();
    const record = records.find(x => x.id === id);
    if (!record) return;
    applyPDFFormData(record.data);
    certificateType = record.certificateType || 'new';
    setCertificateType(certificateType);
    setRegistrationMode(record.registrationMode || 'birth');
    selectedBengaliFont = record.selectedBengaliFont || 'NikoshLight';
    const fontSelect = $('font-selector');
    if (fontSelect) fontSelect.value = selectedBengaliFont;
    changeBengaliFont();
    currentData = record.currentData || currentData || {};
    currentQRImage = record.qrImage || '';
    currentQRLabel = record.qrLabel || '';
    selectedPDFImageId = record.selectedPDFImageId || '';
    selectedPDFImageName = record.selectedPDFImageName || '';
    if(record.imageCoordinateMode==='page-mm'){
      imagePositionX = Number(record.imagePositionX ?? 105); imagePositionY = Number(record.imagePositionY ?? 247);
      imageZoom = Number(record.imageZoom ?? 100); imageWidth = Number(record.imageWidth ?? 24); imageHeight = Number(record.imageHeight ?? 10);
    }else{
      imagePositionX = Math.max(0,Math.min(210,105+Number(record.imagePositionX||0)));
      imagePositionY = Math.max(0,Math.min(297,247+Number(record.imagePositionY||0)));
      imageZoom = Number(record.imageZoom ?? 100); imageWidth = Math.max(8,Math.min(180,Number(record.imageWidth||24))); imageHeight = Math.max(5,Math.min(250,Number(record.imageHeight||10)));
    }
    selectedPDFImageDataUrl = '';
    if(selectedPDFImageId){ try { await ensureSelectedPDFImageData(); } catch(_) {} }
    renderPDFImageLibrary();
    updatePDFImageAdjustUI();
    pdfBlob = record.pdfBlob || null;
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = pdfBlob ? URL.createObjectURL(pdfBlob) : null;
    if (pdfUrl) { $('certIframe').src = pdfUrl; $('certPreview').style.display = 'block'; }
    editingHistoryId = id;
    window.scrollTo({top: 0, behavior: 'smooth'});
    status('History-এর data ফর্মে এসেছে। প্রয়োজনমতো Edit করে আবার “PDF তৈরি করুন” চাপুন।', 'ok');
  } catch (e) { status('History Edit ব্যর্থ: ' + e.message, 'err'); }
}

async function downloadPDFHistory(id) {
  try {
    const records = await getPDFHistory();
    const record = records.find(x => x.id === id);
    if (!record?.pdfBlob) throw new Error('PDF পাওয়া যায়নি।');
    const url = URL.createObjectURL(record.pdfBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Birth_Certificate_' + String(record.data?.in_brn || record.id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { status('History PDF Download ব্যর্থ: ' + e.message, 'err'); }
}

async function deletePDFHistoryItem(id) {
  if (!confirm('এই PDF History থেকে মুছে ফেলবেন?')) return;
  try {
    await deletePDFHistory(id);
    if (editingHistoryId === id) editingHistoryId = null;
    await renderPDFHistory();
    status('PDF History থেকে মুছে ফেলা হয়েছে।', 'ok');
  } catch (e) { status('History Delete ব্যর্থ: ' + e.message, 'err'); }
}

async function renderPDFHistory() {
  const box = $('pdfHistoryList');
  if (!box) return;
  try {
    const records = await getPDFHistory();
    $('historyCount').textContent = records.length;
    if (!records.length) {
      box.innerHTML = '<div class="history-empty">এখনও কোনো PDF History নেই।</div>';
      return;
    }
    box.innerHTML = '';
    records.forEach(record => {
      const item = document.createElement('div'); item.className = 'history-item';
      const info = document.createElement('div'); info.className = 'history-info';
      const name = document.createElement('div'); name.className = 'history-name'; name.textContent = historyDisplayName(record.data);
      const meta = document.createElement('div'); meta.className = 'history-meta';
      meta.textContent = 'BRN: ' + (record.data?.in_brn || '-') + ' • ' + formatHistoryDate(record.createdAt);
      info.append(name, meta);
      const actions = document.createElement('div'); actions.className = 'history-actions';
      const edit = document.createElement('button'); edit.className = 'history-edit'; edit.textContent = '✏️ Edit'; edit.onclick = () => editPDFHistory(record.id);
      const dl = document.createElement('button'); dl.className = 'history-download'; dl.textContent = '⬇️ Download'; dl.onclick = () => downloadPDFHistory(record.id);
      const del = document.createElement('button'); del.className = 'history-delete'; del.textContent = '🗑️ Delete'; del.onclick = () => deletePDFHistoryItem(record.id);
      actions.append(edit, dl, del); item.append(info, actions); box.appendChild(item);
    });
  } catch (e) {
    box.innerHTML = '<div class="history-empty">PDF History চালু করা যায়নি: ' + esc(e.message) + '</div>';
  }
}

// PDF Generation
function getQRLabelFromData(link) {
  // The small text printed below the QR is intentionally a NEW 4-letter
  // code on every QR/PDF generation. It is only a printed label.
  // The QR itself is generated from the exact eVerify/BDRIS verification URL.
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += letters[Math.floor(Math.random() * letters.length)];
  }
  return out;
}

function generateBarcodeSvg(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (typeof JsBarcode !== 'function') {
    throw new Error('Barcode generator load হয়নি। Internet connection/check করুন।');
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.position = 'fixed';
  svg.style.left = '-10000px';
  svg.style.top = '-10000px';
  document.body.appendChild(svg);
  try {
    JsBarcode(svg, text, {
      format: 'CODE128',
      width: 3.5,
      height: 60,
      displayValue: false,
      margin: 0,
      background: 'transparent',
      lineColor: '#000000'
    });
    return svg.outerHTML;
  } finally {
    svg.remove();
  }
}

async function generatePDF(options = {}) {
  const saveHistory = options.saveHistory !== false;
  if(saveHistory) pdfPreviewNeedsHistorySave = false;
  // Generate a fresh printed 4-letter label for every PDF generation.
  // This label is independent from the QR payload.
  const qrLinkForPdf = getAutoQRLink();
  currentQRLabel = getQRLabelFromData(qrLinkForPdf);
  let backgroundImage, bengaliRegularFont, qrImage, barcodeSvg, selectedPDFImage;
  try {
    [backgroundImage, bengaliRegularFont] = await Promise.all([
      imageDataUrl('/birth Background_page-0001-550K.jpg'),
      fontDataUrl('/fonts/NotoSerifBengali-Regular-subset.woff2')
    ]);

    selectedPDFImage = await ensureSelectedPDFImageData();

    const qrLink = getAutoQRLink();
    if (currentQRImage) {
      qrImage = currentQRImage;
    } else if (qrLink) {
      qrImage = await generateQRImage(qrLink);
      currentQRImage = qrImage;
    }

    const brn = $("in_brn").value.trim();
    if (brn) {
      barcodeSvg = await generateBarcodeSvg(brn);
    }
  } catch (error) {
    status('PDF asset/barcode load failed: ' + error.message, 'err');
    return;
  }

  const escPdf = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  const nameBn = $("in_nameBn").value.trim();
  const nameEn = $("in_nameEn").value.trim();
  const dob = $("in_dob").value.trim();
  const birthDate = registrationMode === 'death' ? ($("in_birthDate")?.value.trim() || formatDateDDMMYYYY(currentData?.dob || '')) : '';
  const sex = $("in_sex").value.trim();
  const inWord = $("in_inWord").value.trim() || (registrationMode === 'death' ? dateToInWord(dob) : dateToInWord(dob));
  const brn = $("in_brn").value.trim();
  const regDate = $("in_regDate").value.trim();
  const issuanceDate = $("in_issuanceDate").value.trim();
  const regOffice = capitalizeCase($("in_registrationOffice").value.trim());
  const localOffice = capitalizeCase($("in_upazilaPouroshavaUnion").value.trim());
  const fatherBn = $("in_fatherBn").value.trim();
  const fatherEn = $("in_fatherEn").value.trim();
  const fatherNatBn = $("in_fatherNationalityBn").value.trim();
  const fatherNatEn = $("in_fatherNationalityEn").value.trim();
  const motherBn = $("in_motherBn").value.trim();
  const motherEn = $("in_motherEn").value.trim();
  const motherNatBn = $("in_motherNationalityBn").value.trim();
  const motherNatEn = $("in_motherNationalityEn").value.trim();
  const pobBn = $("in_pobBn").value.trim();
  const pobEn = $("in_pobEn").value.trim();
  const addrBn = registrationMode === 'death' ? '' : $("in_addrBn").value.trim();
  const addrEn = registrationMode === 'death' ? '' : $("in_addrEn").value.trim();
  const deathCauseBn = $("in_deathCauseBn")?.value.trim() || '';
  const deathCauseEn = $("in_deathCauseEn")?.value.trim() || '';
  const selectedFontCSS = {
    NikoshLight: "'NikoshLight','Nikosh','BDRIS Bengali','Noto Serif Bengali',serif",
    SolaimanLipi: "'SolaimanLipi','Siyam Rupali','BDRIS Bengali','Noto Serif Bengali',sans-serif",
    SutonnyOMJ: "'SutonnyOMJ','SutonnyMJ','BDRIS Bengali','Noto Serif Bengali',serif"
  }[selectedBengaliFont] || "'BDRIS Bengali','Noto Serif Bengali',serif";
  const certificateStatus = certificateType === 'corrected' ? {bn:'সংশোধিত/',en:'Corrected'} : certificateType === 'duplicate' ? {bn:'প্রতিলিপি/',en:'Duplicate'} : {bn:'',en:''};

  const css = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { width: 210mm; height: 297mm; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
body { background: #fff; color: #000; font-family: Arial, 'BDRIS Bengali', 'Noto Sans Bengali', sans-serif; font-synthesis: none; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.page-container {
  width: 210mm; height: 297mm; margin: 0; padding: 0;
  position: relative; overflow: hidden;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.bg-image-hq {
  position: absolute; left: 0; top: 0; width: 210mm; height: 297mm;
  display: block; z-index: 0;
  object-fit: fill;
  image-rendering: auto;
}
.content-area { padding: 35mm 22mm 20mm 22mm; height: 100%; position: relative; z-index: 1; }
.bn-text, .label-bn-main, .address-bn-font, .value-bn-main, .value-bn-shift { font-family: ${selectedFontCSS}; font-weight: 400 !important; font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
.serif-text { font-family: 'DejaVu Serif', Georgia, serif; }
.header-section { position: relative; width: 100%; margin-bottom: 2mm; }
.qr-container { position: absolute; left: -5mm; top: -11mm; width: 28mm; display: flex; flex-direction: column; align-items: center; z-index: 10; }
.qr-code-box { width: 28mm; height: 28mm; display: flex; align-items: center; justify-content: center; background: transparent; }
.qr-code-box img { width: 100%; height: 100%; object-fit: cover; }
.qr-text-code { margin-top: 3mm; font-size: 11pt; font-family: Arial, sans-serif; letter-spacing: 2px; color: #000; opacity: 0.5; text-align: center; line-height: 1; position: relative; left: -1mm; }
.barcode-box { position: absolute; right: 4mm; top: -12mm; width: 50mm; height: 6mm; display: flex; align-items: center; justify-content: center; z-index: 10; overflow: hidden; background: transparent; }
.barcode-box svg { width: 100% !important; height: 100% !important; display: block; shape-rendering: crispEdges; }
.cert-status-box { position: absolute; right: 4mm; top: -24mm; border: 1pt solid #000; display: flex; align-items: center; justify-content: center; min-width: 35mm; height: 7mm; padding: 0 2mm; overflow: hidden; white-space: nowrap; line-height: 1; z-index: 20; }
.bn-status { font-family: ${selectedFontCSS}; font-size: 9.5pt; font-weight: 400; }
.cert-status-box > span:last-child { font-family: "DejaVu Serif", serif; font-size: 8pt; font-weight: 400; margin-left: 1mm; }
.header-container { display: block; text-align: center; width: 100%; padding-left: 14mm; margin-left: -3mm; }
.gov-title { font-size: 13pt; font-weight: normal; margin: 0 0 8px 0; text-align: center; }
.office-title { font-size: 11pt; margin: 0 0 7px 0; text-align: center; }
.zone-title-1 { font-size: 11pt; margin: 0 0 7px 0; text-align: center; font-weight: normal; }
.zone-title-2 { font-size: 11pt; margin: 0 0 6px 0; text-align: center; font-weight: normal; }
.rule-title { font-size: 9pt; margin: 6px auto 12px auto; text-align: center; }
.cert-title { margin: 1px auto 0 auto; position: relative; top: -2mm; left: 4mm; text-align: center; display: block; }
.cert-bn { font-size: 18pt; font-weight: bold; }
.cert-en { font-size: 14pt; font-weight: bold; }
.meta-table { width: 100%; margin-top: 2mm; margin-bottom: 35px; border-collapse: collapse; border: none; }
.meta-table td { padding: 2px 0; vertical-align: top; font-size: 10.5pt; border: none; }
.reg-num-label { font-size: 11pt; }
.reg-num-value { font-size: 12pt; }
.meta-value-row td { position: relative; top: -0.5mm; }
.info-table { width: 100%; border-collapse: collapse; margin-bottom: 60px; border: none; }
.info-table td { padding: 6.5px 0; vertical-align: top; font-size: 11pt; line-height: 1.4; position: relative; top: -3mm; border: none; }
.dob-row td { top: -5mm !important; }
.img-row-fix td { top: -7mm !important; }
.address-row-shift td { top: 0 !important; }
.label-bn-main { width: 18%; font-size: 14pt !important; font-weight: 400; }
.address-bn-font { width: 18%; font-size: 13pt !important; font-weight: 400; }
.colon-cell { width: 3%; text-align: center; position: relative; left: 2mm; }
.value-bn-main { width: 32%; font-size: 14pt !important; font-weight: 400; padding-right: 10px; }
.value-bn-shift { position: relative; left: 3mm; }
.label-en { width: 11%; font-size: 11pt; position: relative; left: 0; }
.value-en { width: 36%; font-size: 11pt; position: relative; left: 0; }
.value-en-text { position: relative; left: 3mm; }
.address-en-block { display: inline-block; vertical-align: top; width: calc(100% - 3mm); position: relative; left: 3mm; }
.dob-value-fix { position: relative; left: 3mm; }
.birth-date-row td { top: -5mm !important; padding: 1px 0 !important; line-height: 1.15 !important; }
.death-date-row td { top: -5mm !important; padding: 1px 0 !important; line-height: 1.15 !important; }
.death-date-row { height: auto !important; }
.inword-value-fix { position: relative; left: 3mm; display: inline-block; width: calc(100% - 6mm); font-style: italic !important; font-synthesis: auto !important; transform: skewX(-8deg); transform-origin: left center; }
.sex-container { position: relative; left: 1mm; white-space: nowrap; display: block; text-align: left; }
.sex-container-fixed { position: relative !important; left: 1mm !important; top: 0 !important; margin: 0 !important; padding: 0 !important; white-space: nowrap !important; text-align: left !important; }
.footer-signatures { position: absolute; bottom: 47mm; left: 22mm; right: 22mm; width: calc(100% - 44mm); z-index: 1; }
.sig-table { width: 100%; border-collapse: collapse; border: none; }
.pdf-image-overlay { position:absolute; left:0; top:0; width:210mm; height:297mm; overflow:hidden; pointer-events:none; z-index:100; }
.pdf-image-overlay img { position:absolute; left:${Number(imagePositionX||105)}mm; top:${Number(imagePositionY||247)}mm; width:${Number(imageWidth||24)}mm; height:${Number(imageHeight||10)}mm; max-width:none; max-height:none; object-fit:fill; transform-origin:center center; transform:translate(-50%,-50%) scale(${Number(imageZoom||100)/100}); }
.sig-table td { width: 50%; text-align: center; font-size: 11pt; vertical-align: top; border: none; }
.sig-left-shift { position: relative; left: -12mm; line-height: 1.6 !important; }
.sig-right-shift { position: relative; left: 18mm; line-height: 1.6 !important; }
.sig-bold-target { font-weight: bold; }
.sig-font-11 { font-size: 11pt !important; }
.sig-title { font-weight: normal; }
.bottom-note { position: absolute; z-index: 1; bottom: 29mm; left: 0; width: 100%; text-align: center; font-size: 8.5pt; color: #000; font-family: Arial, sans-serif; }
@font-face { font-family: 'BDRIS Bengali'; src: url('${bengaliRegularFont}') format('woff2'); font-weight: 400; font-style: normal; font-display: block; }
`;

  const htmlContent = `<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8"><title>Birth Registration Certificate</title><style>${css}
/* ===== BRT CERTIFICATES MAK DASHBOARD THEME ===== */
:root{font-family:Arial,"Noto Sans Bengali",sans-serif;color:#e9f7e5;background:#03070d}
body{background:radial-gradient(circle at 10% 10%,#123016 0,transparent 24%),radial-gradient(circle at 92% 25%,#0b2511 0,transparent 22%),#03070d;min-height:100vh}
.wrap{max-width:1400px;margin:0 auto;padding:22px 24px 28px;background:transparent;border-radius:0;box-shadow:none}
.app-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:8px}.app-brand{display:flex;align-items:center;gap:13px}.app-logo{width:48px;height:48px;border:1px solid #74ed4d;border-radius:14px;display:grid;place-items:center;color:#8aff64;font-size:24px;box-shadow:0 0 24px #65ff3c33;background:#65ff3c0b}.app-head h1{margin:0;text-align:left;font-size:34px;color:#f4fff1}.brand-en{margin:2px 0 0;color:#72e94c;font-size:11px;letter-spacing:1.5px;font-weight:700}.online-pill{border:1px solid #315d2b;background:#08130b;color:#b7dcb0;padding:8px 13px;border-radius:999px;font-size:12px;box-shadow:0 0 14px #65ff3c15}.online-pill span{display:inline-block;width:8px;height:8px;border-radius:50%;background:#71ef4d;box-shadow:0 0 10px #71ef4d;margin-right:6px;animation:onlinePulse 1.8s infinite}
.sub{text-align:left;color:#87978d;margin:0 0 20px;padding-left:61px}.grid{gap:12px}.grid>label{color:#a9d69d}.grid input,.grid textarea,.grid select{color:#eaf6e6;background:#0a1117;border:1px solid #293841;box-shadow:inset 0 0 12px #0007;transition:.25s}.grid input:focus,.grid textarea:focus,.grid select:focus{border-color:#6ee94b;box-shadow:0 0 0 2px #65ff3c12,0 0 17px #65ff3c22,inset 0 0 12px #0007;outline:none}.grid textarea{min-height:78px}
.grid[style]{background:linear-gradient(145deg,#07100c,#0a1219)!important;border:1px solid #29432a;padding:17px!important;border-radius:14px!important;box-shadow:0 0 24px #65ff3c0d}.grid[style] label{font-size:12px}.grid[style] input{height:45px}
.actions{gap:10px}.top-actions{margin:14px 0}.top-actions button,.side-card button{transition:.22s}.open{background:linear-gradient(135deg,#7df04f,#4cb63b);color:#071007;box-shadow:0 0 18px #65ff3c2f}.open:hover{transform:translateY(-2px);box-shadow:0 0 26px #65ff3c55}.clear{background:#18232b;color:#dbe6df;border:1px solid #31414a}.status{background:#08150d;color:#8eb493;border:1px solid #234c29;box-shadow:inset 0 0 15px #65ff3c07}.status.ok{background:#0b1c10;color:#91ef7b;border-color:#326c35}.status.err{background:#210d10;color:#ff8585;border-color:#762e36}
.workspace-grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px;align-items:start}.form-main,.side-card,.type-panel,.font-panel,.cert-preview{background:linear-gradient(145deg,#071017e8,#08100de8);border:1px solid #21362a;border-radius:15px;box-shadow:0 0 28px #0006,inset 0 0 30px #65ff3c04}.form-main{padding:18px}.form-section-title{display:flex;align-items:center;gap:10px;color:#8bea65;margin-bottom:15px}.form-section-title>span{width:38px;height:38px;border:1px solid #5cc944;border-radius:10px;display:grid;place-items:center;background:#65ff3c0d;box-shadow:0 0 14px #65ff3c1b}.form-section-title strong{display:block;font-size:17px}.form-section-title small{display:block;color:#718078;font-size:11px;margin-top:2px}.side-bar{display:flex;flex-direction:column;gap:14px;position:sticky;top:16px}.side-card{padding:15px}.side-card h3{margin:0 0 12px;color:#dcebd7;font-size:15px}.side-card h3 .badge{float:right}.side-card button{width:100%;margin:6px 0;text-align:left;color:#fff;border-radius:10px;min-height:52px;padding:9px 13px;font-size:13px}.side-card button small{display:block;font-size:10px;opacity:.72;margin-top:2px}.side-auto{background:linear-gradient(135deg,#0c7892,#164e69);border:1px solid #1bc6ef;box-shadow:0 0 14px #0eb5d822}.side-clear{background:linear-gradient(135deg,#6b4a09,#7b5b16);border:1px solid #e8a928}.side-preview{background:linear-gradient(135deg,#4a2671,#6532a1);border:1px solid #a86df2}.side-pdf{background:linear-gradient(135deg,#9d2427,#d83d40);border:1px solid #ff5b5e;box-shadow:0 0 16px #ff404022}.side-card button:hover{transform:translateY(-2px);filter:brightness(1.08)}
.type-panel,.font-panel{margin-top:18px;padding:15px;background:#071017}.type-panel label,.font-panel label{color:#a7d89a}.type-buttons button{border:1px solid #304138}.font-panel select{color:#eaf6e6;background:#0b1319;border-color:#293b43}.font-panel .small{color:#728079}.cert-preview{margin-top:18px;padding:14px;background:#050b10;border-style:solid}.preview-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.preview-head h3{margin:0;color:#dff0da}.preview-head small{color:#718078}.preview-live{font-size:10px;color:#7bea5b}.cert-preview iframe{border-radius:10px;box-shadow:0 0 18px #0008}.pdf-preview-workspace{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:14px;align-items:start}.pdf-preview-frame{min-width:0}.pdf-preview-frame iframe{width:100%;height:650px;border:0;background:#fff}.pdf-image-adjust{margin:0;padding:10px;border:1px solid #294a2e;border-radius:10px;background:#07130b;position:sticky;top:10px}.pdf-adjust-buttons{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.pdf-adjust-buttons button{width:100%!important;min-height:34px!important;margin:0!important;padding:6px!important;text-align:center!important;background:#15251a!important;border:1px solid #315d36!important;color:#a9d99f!important;font-size:10px!important}.pdf-adjust-buttons .pdf-adjust-download{grid-column:1/-1;background:#197b48!important;color:#fff!important;border-color:#39a86b!important}.pdf-image-adjust-preview{height:120px;cursor:move;touch-action:none;border:1px dashed #3d5c45;border-radius:7px;background:#f8f8f8;overflow:hidden;position:relative;margin-bottom:8px}.pdf-image-adjust-safe{position:absolute;left:3%;right:3%;top:15%;height:70%;border:1px solid #a4c79e;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#fff}.pdf-image-adjust-safe img{width:100%;height:100%;object-fit:fill;transform-origin:center center}@media(max-width:950px){.pdf-preview-workspace{grid-template-columns:1fr}.pdf-image-adjust{position:static}.pdf-preview-frame iframe{height:600px}}.history-panel{margin-top:0;padding:14px}.history-empty{background:#081017;color:#6f7e77;border-color:#263831}.history-item{background:#0b141a;border-color:#263831;transition:.2s}.history-item:hover{border-color:#5caf47;box-shadow:0 0 14px #65ff3c0e}.history-name{color:#dcebd7}.history-meta{color:#718079}.history-actions button{border:1px solid transparent}.history-edit{background:#175ea8}.history-download{background:#197b48}.history-delete{background:#a72c35}
#allFields{display:none}.section{display:none}.badge{background:#17331b;color:#87ea69;border:1px solid #315f36}@keyframes onlinePulse{0%,100%{opacity:.7;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
@media(max-width:950px){.workspace-grid{grid-template-columns:1fr}.side-bar{position:static;display:grid;grid-template-columns:1fr 1fr}.quick-card{grid-column:1/-1}.history-panel{grid-column:1/-1}.sub{padding-left:0}}
@media(max-width:700px){.wrap{padding:15px 12px 24px}.app-head{align-items:flex-start}.app-head h1{font-size:25px}.app-logo{width:40px;height:40px}.online-pill{font-size:10px;padding:7px 9px}.side-bar{display:flex}.workspace-grid{gap:12px}.form-main{padding:13px}.top-actions button{flex:1}.grid[style]{padding:12px!important}.cert-preview iframe{height:520px}}


/* ===== MODERN GLASS BRT UI ===== */
:root{font-family:"Noto Sans Bengali","Noto Serif Bengali",Arial,sans-serif}
body:not(.login-locked){background:radial-gradient(circle at 8% 0%,rgba(30,58,138,.20),transparent 28%),radial-gradient(circle at 95% 20%,rgba(16,185,129,.10),transparent 25%),#f3f6fa!important;color:#152238!important}
body:not(.login-locked) .wrap{max-width:1180px!important;padding:18px 16px 34px!important}
body:not(.login-locked) .app-head{padding:16px 18px;border-radius:22px;background:linear-gradient(135deg,#0b245f,#123f83 62%,#0f4c81);box-shadow:0 18px 40px rgba(15,76,129,.20);position:relative;overflow:hidden}
body:not(.login-locked) .app-head:after{content:"";position:absolute;inset:auto -10% -65% 45%;height:180px;background:rgba(255,255,255,.08);border-radius:50%;filter:blur(8px)}
body:not(.login-locked) .app-logo{border:1px solid rgba(255,255,255,.35)!important;background:rgba(255,255,255,.12)!important;color:#fff!important;box-shadow:0 8px 24px rgba(0,0,0,.16)!important}
body:not(.login-locked) .app-head h1{color:#fff!important;font-size:28px!important}
body:not(.login-locked) .brand-en{color:#cfe2ff!important}
body:not(.login-locked) .online-pill{background:rgba(255,255,255,.10)!important;border-color:rgba(255,255,255,.22)!important;color:#fff!important;position:relative;z-index:2}
body:not(.login-locked) .online-pill span{background:#10b981!important;box-shadow:0 0 12px #10b981!important}
body:not(.login-locked) .sub{color:#5c6b7d!important;padding-left:4px!important}
body:not(.login-locked) #userBalanceBar{background:rgba(255,255,255,.72)!important;border:1px solid rgba(255,255,255,.9)!important;color:#26364d!important;box-shadow:0 10px 28px rgba(15,35,65,.07)!important;backdrop-filter:blur(12px)}
body:not(.login-locked) #userBalanceBar a{color:#0f4c81!important}
body:not(.login-locked) .modern-stepper{display:flex;align-items:center;gap:8px;margin:14px 0 16px;padding:10px;border:1px solid rgba(255,255,255,.9);border-radius:18px;background:rgba(255,255,255,.58);backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(15,35,65,.07)}
body:not(.login-locked) .modern-step{flex:1;display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:13px;color:#6a7788;font-size:12px;font-weight:800;min-width:0}
body:not(.login-locked) .modern-step .num{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#e8eef7;color:#52647c;flex:0 0 auto}
body:not(.login-locked) .modern-step.active{background:linear-gradient(135deg,#eaf2ff,#fff);color:#0f4c81;box-shadow:0 7px 18px rgba(15,76,129,.10)}
body:not(.login-locked) .modern-step.active .num{background:#1e3a8a;color:#fff;box-shadow:0 5px 12px rgba(30,58,138,.22)}
body:not(.login-locked) .modern-step small{display:block;font-size:9px;font-weight:600;color:#8793a3;margin-top:2px}
body:not(.login-locked) .search-fields-stack{background:rgba(255,255,255,.68)!important;border:1px solid rgba(255,255,255,.95)!important;border-radius:22px!important;padding:18px!important;box-shadow:0 14px 34px rgba(15,35,65,.08)!important;backdrop-filter:blur(16px)}
body:not(.login-locked) .search-fields-stack label{color:#1f2f46!important;font-size:13px}
body:not(.login-locked) input,body:not(.login-locked) textarea,body:not(.login-locked) select{background:#f4f6f9!important;color:#17243a!important;border:1px solid #d7dee8!important;border-radius:12px!important;min-height:44px;transition:border-color .22s,box-shadow .22s,transform .18s}
body:not(.login-locked) input:focus,body:not(.login-locked) textarea:focus,body:not(.login-locked) select:focus{border-color:#1e3a8a!important;box-shadow:0 0 0 3px rgba(30,58,138,.10),0 7px 18px rgba(30,58,138,.08)!important;transform:translateY(-1px)}
body:not(.login-locked) .actions.top-actions{gap:10px}
body:not(.login-locked) .actions.top-actions .open{background:linear-gradient(135deg,#1e3a8a,#0f4c81)!important;color:#fff!important;border-radius:13px!important;box-shadow:0 10px 22px rgba(15,76,129,.22)!important}
body:not(.login-locked) .actions.top-actions .clear{background:#fff!important;color:#33445b!important;border:1px solid #d6dee9!important;border-radius:13px!important}
body:not(.login-locked) .actions button:active{transform:scale(.98)}
body:not(.login-locked) .status{background:rgba(255,255,255,.68)!important;border:1px solid rgba(255,255,255,.9)!important;color:#4f6075!important;border-radius:14px!important;box-shadow:0 8px 22px rgba(15,35,65,.06)!important}
body:not(.login-locked) .status.ok{background:rgba(236,253,245,.82)!important;color:#08764f!important;border-color:#b8ead7!important}
body:not(.login-locked) .top-settings-panel{gap:14px!important}
body:not(.login-locked) .top-setting-card{background:rgba(255,255,255,.70)!important;border:1px solid rgba(255,255,255,.95)!important;border-radius:20px!important;box-shadow:0 14px 34px rgba(15,35,65,.08)!important;backdrop-filter:blur(14px)!important}
body:not(.login-locked) .top-setting-card h3{color:#17263d!important}
body:not(.login-locked) .type-buttons button{background:#fff!important;color:#33445b!important;border:1px solid #d6dee9!important;border-radius:13px!important;box-shadow:none!important;transition:.2s!important}
body:not(.login-locked) .type-buttons button.active{background:linear-gradient(135deg,#1e3a8a,#0f4c81)!important;color:#fff!important;outline:0!important;box-shadow:0 8px 18px rgba(30,58,138,.18)!important}
body:not(.login-locked) .workspace-grid{display:block!important}
body:not(.login-locked) .form-main{padding:18px!important;background:rgba(255,255,255,.58)!important;border:1px solid rgba(255,255,255,.90)!important;border-radius:24px!important;box-shadow:0 18px 45px rgba(15,35,65,.09)!important;backdrop-filter:blur(18px)!important}
body:not(.login-locked) .form-section-title{padding:6px 2px 12px;color:#1e3a8a!important}
body:not(.login-locked) .form-section-title>span{background:linear-gradient(135deg,#eaf2ff,#fff)!important;border-color:#cbdcf8!important;color:#1e3a8a!important;box-shadow:0 8px 18px rgba(30,58,138,.10)!important}
body:not(.login-locked) .form-section-title small{color:#7a889a!important}
body:not(.login-locked) #certificateFields{gap:12px!important}
body:not(.login-locked) #certificateFields>label{background:rgba(255,255,255,.46);padding:2px 0;border-radius:12px;color:#26364d!important}
body:not(.login-locked) .section-divider{background:linear-gradient(135deg,rgba(234,242,255,.92),rgba(255,255,255,.65))!important;border:1px solid #d6e3f7!important;color:#1e3a8a!important;border-radius:14px!important;box-shadow:0 7px 18px rgba(30,58,138,.06)!important;margin-top:10px!important}
body:not(.login-locked) .section-divider small{color:#7b899c!important}
body:not(.login-locked) .bottom-preview-action{margin:18px 0 4px!important}
body:not(.login-locked) .bottom-preview-action .pdf{min-width:280px!important;background:linear-gradient(135deg,#0f4c81,#1e3a8a)!important;color:#fff!important;border-radius:14px!important;box-shadow:0 12px 24px rgba(15,76,129,.22)!important}
body:not(.login-locked) .cert-preview{background:rgba(255,255,255,.64)!important;border:1px solid rgba(255,255,255,.95)!important;border-radius:24px!important;padding:16px!important;box-shadow:0 18px 45px rgba(15,35,65,.10)!important;backdrop-filter:blur(16px)!important;perspective:1200px;animation:previewIn .42s ease both}
body:not(.login-locked) .preview-head{padding:4px 4px 12px}
body:not(.login-locked) .preview-head h3{color:#173d78!important}
body:not(.login-locked) .preview-head small{color:#738196!important}
body:not(.login-locked) .preview-live{color:#10b981!important}
body:not(.login-locked) .pdf-preview-frame iframe{background:#fff;border-radius:16px!important;box-shadow:0 18px 35px rgba(15,35,65,.16)!important;transform:rotateX(.35deg);transform-origin:center top}
body:not(.login-locked) .preview-download-bar{display:flex;gap:10px;margin-top:12px}
body:not(.login-locked) .preview-download-bar button{flex:1;min-height:46px;border-radius:13px;border:1px solid #d5deeb;font-weight:800;transition:.2s}
body:not(.login-locked) .preview-download-bar .download-cert{background:linear-gradient(135deg,#10b981,#079669);color:#fff;border-color:#10b981;box-shadow:0 10px 22px rgba(16,185,129,.20)}
body:not(.login-locked) .preview-download-bar .close-preview{background:#fff;color:#33445b}
body:not(.login-locked) .preview-download-bar button:hover{transform:translateY(-1px)}
body:not(.login-locked) .side-menu-trigger{left:auto!important;right:10px!important;top:74px!important;transform:none!important;width:40px!important;height:40px!important;border:1px solid rgba(255,255,255,.25)!important;border-radius:12px!important;background:rgba(255,255,255,.10)!important;color:#fff!important;box-shadow:none!important;z-index:10003!important}
body:not(.login-locked) .side-bar{background:linear-gradient(180deg,#0b245f,#102f63 45%,#0f4c81)!important;border-right:1px solid rgba(255,255,255,.18)!important}
body:not(.login-locked) .side-bar:before{color:#fff;border-color:rgba(255,255,255,.18)}
body:not(.login-locked) .side-bar .side-card{background:rgba(255,255,255,.09)!important;border-color:rgba(255,255,255,.16)!important;box-shadow:0 12px 28px rgba(0,0,0,.12)!important;backdrop-filter:blur(12px)}
body:not(.login-locked) .side-card h3,body:not(.login-locked) .history-name{color:#fff!important}
body:not(.login-locked) .side-bar .history-meta,body:not(.login-locked) .side-bar .history-empty{color:#c9d7ec!important}
body:not(.login-locked) .side-bar .history-empty{background:rgba(255,255,255,.07)!important;border-color:rgba(255,255,255,.15)!important}
@keyframes previewIn{from{opacity:0;transform:translateY(12px) rotateX(-1deg)}to{opacity:1;transform:none}}
@keyframes glassPulse{0%,100%{box-shadow:0 18px 45px rgba(15,35,65,.09)}50%{box-shadow:0 20px 50px rgba(30,58,138,.13)}}
@media(max-width:700px){
body:not(.login-locked) .wrap{padding:10px 10px 28px!important}
body:not(.login-locked) .app-head{padding:13px 14px;border-radius:20px}
body:not(.login-locked) .app-head h1{font-size:22px!important}
body:not(.login-locked) .app-logo{width:42px;height:42px}
body:not(.login-locked) .online-pill{font-size:9px;padding:6px 8px}
body:not(.login-locked) .sub{font-size:11px;margin:8px 2px 12px}
body:not(.login-locked) .modern-stepper{gap:4px;padding:7px;border-radius:15px;overflow:hidden}
body:not(.login-locked) .modern-step{padding:7px 5px;gap:5px;font-size:10px}
body:not(.login-locked) .modern-step .num{width:25px;height:25px;font-size:10px}
body:not(.login-locked) .modern-step small{display:none}
body:not(.login-locked) #userBalanceBar{font-size:10px!important;padding:9px 10px!important}
body:not(.login-locked) .form-main{padding:12px!important;border-radius:20px!important}
body:not(.login-locked) .search-fields-stack{padding:13px!important;border-radius:18px!important}
body:not(.login-locked) input,body:not(.login-locked) textarea,body:not(.login-locked) select{min-height:46px;font-size:14px}
body:not(.login-locked) .type-buttons button{min-height:54px!important;font-size:10px!important}
body:not(.login-locked) .bottom-preview-action .pdf{width:100%;min-width:0!important}
body:not(.login-locked) .cert-preview{border-radius:20px!important;padding:10px!important}
body:not(.login-locked) .preview-head small{display:none}
body:not(.login-locked) .pdf-preview-frame iframe{height:520px!important;border-radius:12px!important}
body:not(.login-locked) .preview-download-bar{position:sticky;bottom:6px;z-index:4;background:rgba(243,246,250,.84);backdrop-filter:blur(10px);padding-top:8px}
}


/* CLEAN MODERN BRT UI: final visual override */
body:not(.login-locked){background:#f7f9fc!important;color:#18263b!important}
body:not(.login-locked) .wrap{max-width:1180px!important;margin:0 auto!important;padding:18px 22px 40px!important}
body:not(.login-locked) .app-head{background:linear-gradient(135deg,#0b3f82,#145bb5)!important;border-radius:0 0 18px 18px!important;margin:0 -22px 14px!important;padding:16px 22px!important;box-shadow:0 8px 24px rgba(15,76,129,.16)!important}
body:not(.login-locked) .app-brand{align-items:center!important}
body:not(.login-locked) .app-logo{width:48px!important;height:48px!important;object-fit:contain!important;border-radius:50%!important;background:#fff!important;padding:2px!important;box-shadow:0 3px 10px rgba(0,0,0,.12)!important}
body:not(.login-locked) .app-head h1{color:#fff!important;font-size:25px!important;letter-spacing:.1px!important}
body:not(.login-locked) .brand-en{color:#dcecff!important;font-size:12px!important}
body:not(.login-locked) .online-pill{background:rgba(255,255,255,.13)!important;border:1px solid rgba(255,255,255,.22)!important;color:#fff!important}
body:not(.login-locked) #userBalanceBar{background:#fff!important;color:#34445b!important;border:1px solid #e4eaf2!important;border-radius:12px!important;box-shadow:0 4px 14px rgba(30,55,90,.06)!important}
body:not(.login-locked) #userBalanceBar a{color:#0f4c81!important}
.clean-section-heading{display:flex;align-items:center;gap:12px;margin:18px 0 10px;padding:4px 2px;color:#0f4c81}
.clean-section-heading .section-number{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#1e5eae;color:#fff;font-weight:900;font-size:15px;box-shadow:0 5px 12px rgba(30,94,174,.18)}
.clean-section-heading strong{display:block;font-size:19px;line-height:1.15}.clean-section-heading small{display:block;color:#7b8798;font-size:11px;margin-top:3px;font-weight:600}
body:not(.login-locked) .search-fields-stack{display:grid!important;grid-template-columns:1fr 1fr!important;gap:16px!important;background:#fff!important;border:1px solid #e4eaf2!important;border-radius:16px!important;padding:18px!important;box-shadow:0 8px 24px rgba(25,52,86,.07)!important}
body:not(.login-locked) .search-fields-stack label{font-weight:800!important;color:#25344b!important}
body:not(.login-locked) .actions.top-actions{margin:10px 0!important}
body:not(.login-locked) .actions.top-actions .open{min-height:48px!important;border-radius:10px!important;background:#145bb5!important;box-shadow:0 7px 16px rgba(20,91,181,.20)!important}
body:not(.login-locked) .actions.top-actions .clear{min-height:48px!important;border-radius:10px!important}
body:not(.login-locked) .captcha-box{border-radius:14px!important;border:1px solid #e1e8f1!important;background:#fff!important;box-shadow:0 7px 20px rgba(25,52,86,.06)!important}
body:not(.login-locked) .status{border-radius:12px!important;box-shadow:none!important;background:#fff!important;border:1px solid #e4eaf2!important}
body:not(.login-locked) .top-settings-panel{margin-top:12px!important}
body:not(.login-locked) .top-setting-card{background:#fff!important;border:1px solid #e4eaf2!important;border-radius:14px!important;box-shadow:0 7px 20px rgba(25,52,86,.06)!important;backdrop-filter:none!important}
body:not(.login-locked) .workspace-grid{display:block!important}
body:not(.login-locked) .form-main{background:#fff!important;border:1px solid #e4eaf2!important;border-radius:16px!important;padding:18px!important;box-shadow:0 8px 24px rgba(25,52,86,.07)!important;backdrop-filter:none!important}
body:not(.login-locked) .form-section-title{border-bottom:1px solid #e9eef5!important;padding-bottom:12px!important}
body:not(.login-locked) #certificateFields{gap:14px!important}
body:not(.login-locked) #certificateFields>label{background:transparent!important;padding:0!important}
body:not(.login-locked) input,body:not(.login-locked) textarea,body:not(.login-locked) select{background:#f4f6f9!important;border:1px solid #d9e0e9!important;border-radius:10px!important;box-shadow:none!important}
body:not(.login-locked) input:focus,body:not(.login-locked) textarea:focus,body:not(.login-locked) select:focus{border-color:#1e5eae!important;box-shadow:0 0 0 3px rgba(30,94,174,.10)!important;transform:none!important}
body:not(.login-locked) .section-divider{background:#f5f8fc!important;border:1px solid #dce5ef!important;border-radius:10px!important;color:#0f4c81!important;box-shadow:none!important}
body:not(.login-locked) .bottom-preview-action{margin:16px 0 10px!important;text-align:left!important}
body:not(.login-locked) .bottom-preview-action .pdf{min-width:240px!important;border-radius:10px!important;background:#145bb5!important;box-shadow:0 7px 16px rgba(20,91,181,.18)!important}
body:not(.login-locked) .cert-preview{background:#fff!important;border:1px solid #e4eaf2!important;border-radius:16px!important;box-shadow:0 10px 28px rgba(25,52,86,.09)!important;backdrop-filter:none!important}
body:not(.login-locked) .preview-head h3{color:#0f4c81!important}
body:not(.login-locked) .preview-download-bar{display:flex!important;gap:10px!important}
body:not(.login-locked) .preview-download-bar button{border-radius:10px!important}
body:not(.login-locked) .preview-download-bar .download-cert{background:#10b981!important}
body:not(.login-locked) .side-bar{display:none!important}
body:not(.login-locked) .side-menu-trigger{display:flex!important;right:18px!important;top:20px!important;background:rgba(255,255,255,.10)!important}
@media(max-width:700px){
 body:not(.login-locked) .wrap{padding:10px 10px 28px!important}
 body:not(.login-locked) .app-head{margin:0 -10px 12px!important;border-radius:0 0 16px 16px!important;padding:13px 14px!important}
 body:not(.login-locked) .app-logo{width:42px!important;height:42px!important}
 body:not(.login-locked) .app-head h1{font-size:21px!important}
 body:not(.login-locked) .brand-en{font-size:10px!important}
 .clean-section-heading{margin:15px 2px 9px}.clean-section-heading strong{font-size:17px}.clean-section-heading small{font-size:10px}
 .clean-section-heading .section-number{width:31px;height:31px;font-size:13px}
 body:not(.login-locked) .search-fields-stack{grid-template-columns:1fr!important;padding:14px!important;border-radius:14px!important}
 body:not(.login-locked) .actions.top-actions{display:grid!important;grid-template-columns:1fr 92px!important}
 body:not(.login-locked) .form-main{padding:13px!important;border-radius:14px!important}
 body:not(.login-locked) .bottom-preview-action .pdf{width:100%!important}
 body:not(.login-locked) .cert-preview{padding:10px!important;border-radius:14px!important}
 body:not(.login-locked) .preview-download-bar{position:sticky;bottom:6px;padding:8px;background:rgba(247,249,252,.96);border-radius:10px}
}
</style>
<style id="clean-modern-final-ui">
/* FINAL CLEAN MODERN BLUE/WHITE UI - preserves existing field IDs and JS */
body:not(.login-locked){
  background:#f4f7fb !important;color:#18212b !important;
  font-family:"Noto Sans Bengali","Hind Siliguri",Arial,sans-serif !important;
}
body:not(.login-locked) #appShell{background:#f4f7fb !important;min-height:100vh}
body:not(.login-locked) .wrap{
  max-width:1180px !important;margin:0 auto !important;padding:0 22px 34px !important;
  background:transparent !important;border-radius:0 !important;box-shadow:none !important;
}
body:not(.login-locked) .app-head{
  margin:0 -22px !important;padding:18px 28px !important;
  min-height:86px;background:linear-gradient(135deg,#0f4c81,#1e3a8a) !important;
  color:#fff !important;border-radius:0 0 18px 18px !important;
  box-shadow:0 8px 25px rgba(15,76,129,.20) !important;
}
body:not(.login-locked) .app-logo{width:52px !important;height:52px !important;border-radius:50% !important}
body:not(.login-locked) .app-brand h1{color:#fff !important;font-size:27px !important;margin:0 !important}
body:not(.login-locked) .brand-en{color:#dbeafe !important}
body:not(.login-locked) .online-pill{
  background:rgba(255,255,255,.12) !important;border:1px solid rgba(255,255,255,.28) !important;
  color:#fff !important;box-shadow:none !important;
}
body:not(.login-locked) .online-pill span{background:#10b981 !important;box-shadow:0 0 10px rgba(16,185,129,.6) !important}
body:not(.login-locked) .sub{color:#5f6b7a !important;margin:14px 0 8px !important}
body:not(.login-locked) #userBalanceBar{
  background:#fff !important;color:#233044 !important;border:1px solid #dce5ef !important;
  box-shadow:0 3px 14px rgba(15,23,42,.06) !important;
}
body:not(.login-locked) #userBalanceBar a{color:#0f4c81 !important}

body:not(.login-locked) .clean-section-heading{
  display:flex !important;align-items:center !important;gap:10px !important;
  margin:22px 0 10px !important;padding:0 2px !important;
}
body:not(.login-locked) .clean-section-heading .section-number{display:none !important}
body:not(.login-locked) .clean-section-heading strong{
  color:#0f4c81 !important;font-size:20px !important;font-weight:800 !important;
}
body:not(.login-locked) .clean-section-heading small{
  display:block !important;color:#7a8797 !important;font-size:12px !important;margin-top:2px !important;
}

body:not(.login-locked) .search-fields-stack{
  display:grid !important;grid-template-columns:1fr 1fr !important;gap:18px !important;
  margin:0 !important;padding:20px !important;background:#fff !important;
  border:1px solid #e0e8f0 !important;border-radius:14px !important;
  box-shadow:0 5px 20px rgba(15,23,42,.06) !important;
}
body:not(.login-locked) label{color:#243246 !important}
body:not(.login-locked) input,body:not(.login-locked) textarea,body:not(.login-locked) select{
  background:#f4f6f9 !important;color:#18212b !important;border:1px solid #d4dde8 !important;
  border-radius:9px !important;transition:border-color .2s,box-shadow .2s,background .2s !important;
}
body:not(.login-locked) input:focus,body:not(.login-locked) textarea:focus,body:not(.login-locked) select:focus{
  background:#fff !important;border-color:#1e6fd9 !important;
  box-shadow:0 0 0 3px rgba(30,111,217,.12) !important;outline:none !important;
}
body:not(.login-locked) .actions{margin:12px 0 !important}
body:not(.login-locked) button.open,body:not(.login-locked) button.read,body:not(.login-locked) button.save,body:not(.login-locked) .download-cert{
  background:linear-gradient(135deg,#1769c2,#1e3a8a) !important;color:#fff !important;border:0 !important;
  box-shadow:0 5px 15px rgba(30,58,138,.18) !important;transition:transform .18s,box-shadow .18s !important;
}
body:not(.login-locked) button.open:hover,body:not(.login-locked) button.read:hover,body:not(.login-locked) .download-cert:hover{transform:translateY(-1px);box-shadow:0 8px 18px rgba(30,58,138,.25)!important}
body:not(.login-locked) button.clear{background:#fff !important;color:#334155 !important;border:1px solid #cbd5e1 !important}
body:not(.login-locked) .status{
  background:#fff !important;border:1px solid #dce7e3 !important;color:#176b35 !important;
  border-radius:11px !important;box-shadow:0 3px 12px rgba(15,23,42,.04) !important;
}
body:not(.login-locked) .top-settings-panel{
  display:grid !important;grid-template-columns:1.4fr .9fr !important;gap:12px !important;
  margin:14px 0 !important;
}
body:not(.login-locked) .top-setting-card{
  background:#fff !important;border:1px solid #e0e8f0 !important;border-radius:14px !important;
  padding:15px !important;box-shadow:0 5px 18px rgba(15,23,42,.05) !important;
}
body:not(.login-locked) .top-setting-card h3{color:#1e3a8a !important;margin:0 0 10px !important}
body:not(.login-locked) .type-buttons{gap:10px !important}
body:not(.login-locked) .type-buttons button{border-radius:9px !important;opacity:.9 !important}
body:not(.login-locked) .type-buttons button.active{outline:3px solid rgba(30,111,217,.16) !important;opacity:1 !important}

body:not(.login-locked) .workspace-grid{display:block !important}
body:not(.login-locked) .form-main{
  background:#fff !important;border:1px solid #e0e8f0 !important;border-radius:14px !important;
  padding:18px !important;box-shadow:0 5px 20px rgba(15,23,42,.06) !important;
}
body:not(.login-locked) .form-section-title{
  display:flex !important;align-items:center !important;gap:10px !important;
  color:#0f4c81 !important;border-bottom:1px solid #e7edf4 !important;padding-bottom:12px !important;margin-bottom:15px !important;
}
body:not(.login-locked) .form-section-title strong{font-size:18px !important}
body:not(.login-locked) #allFields,body:not(.login-locked) #certificateFields{
  display:grid !important;grid-template-columns:1fr 1fr !important;gap:13px !important;
}
body:not(.login-locked) .section-divider{
  grid-column:1/-1 !important;margin:7px 0 0 !important;padding:11px 12px !important;
  border:1px solid #dce8f4 !important;border-radius:10px !important;background:#f7faff !important;
  color:#0f4c81 !important;font-weight:800 !important;
}
body:not(.login-locked) .side-bar{display:none !important}
body:not(.login-locked) #sideMenuTrigger{display:flex !important;background:#fff !important;color:#0f4c81 !important;border:1px solid #d5dfeb !important;box-shadow:0 4px 12px rgba(15,23,42,.08)!important}
body:not(.login-locked) .preview-heading{margin-top:25px !important}
body:not(.login-locked) .bottom-preview-action{text-align:left !important;margin:0 0 12px !important}
body:not(.login-locked) .bottom-preview-action .pdf{
  background:linear-gradient(135deg,#1769c2,#1e3a8a) !important;color:#fff !important;border:0 !important;
  border-radius:10px !important;box-shadow:0 5px 16px rgba(30,58,138,.18) !important;
}
body:not(.login-locked) .cert-preview{
  background:#fff !important;border:1px solid #dce5ef !important;border-radius:14px !important;
  padding:16px !important;box-shadow:0 7px 24px rgba(15,23,42,.08) !important;
}
body:not(.login-locked) .preview-head h3{color:#0f4c81 !important}
body:not(.login-locked) .preview-live{color:#10b981 !important}
body:not(.login-locked) .preview-download-bar{display:flex !important;gap:10px !important;justify-content:flex-end !important;flex-wrap:wrap !important;margin-top:12px !important}
body:not(.login-locked) .close-preview{background:#fff !important;color:#334155 !important;border:1px solid #cbd5e1 !important}

@media(max-width:760px){
 body:not(.login-locked) .wrap{padding:0 12px 25px !important}
 body:not(.login-locked) .app-head{margin:0 -12px !important;padding:15px 16px !important;border-radius:0 0 15px 15px !important}
 body:not(.login-locked) .app-logo{width:45px !important;height:45px !important}
 body:not(.login-locked) .app-brand h1{font-size:22px !important}
 body:not(.login-locked) .brand-en{font-size:10px !important}
 body:not(.login-locked) .search-fields-stack,
 body:not(.login-locked) #allFields,
 body:not(.login-locked) #certificateFields,
 body:not(.login-locked) .top-settings-panel{grid-template-columns:1fr !important}
 body:not(.login-locked) .search-fields-stack{padding:15px !important}
 body:not(.login-locked) .form-main{padding:14px !important}
 body:not(.login-locked) .clean-section-heading strong{font-size:18px !important}
 body:not(.login-locked) .preview-download-bar>*{flex:1 1 100% !important}
}
/* ===== LOGIN: PERSON WALKS IN BESIDE THE LAMP, THEN POINTS ===== */
 .walking-person{position:absolute;left:-160px;bottom:48px;width:100px;height:205px;z-index:20;pointer-events:none;filter:drop-shadow(0 5px 6px #0008);animation:personWalkLoop 6s linear infinite;will-change:left,transform;}
.walking-person .person-head{position:absolute;left:24px;top:5px;width:38px;height:40px;transform-origin:50% 100%;border-radius:50%;background:linear-gradient(145deg,#f6c394,#b96e48);box-shadow:inset -4px -3px 0 #95573d;}
.walking-person .person-hair{position:absolute;left:24px;top:1px;width:38px;height:15px;border-radius:50% 50% 35% 35%;background:#171311;transform:rotate(-5deg);}
.walking-person .person-body{position:absolute;left:20px;top:43px;width:47px;height:72px;transform-origin:50% 100%;border-radius:15px 15px 10px 10px;background:linear-gradient(#315f9e,#234a7d);}
.walking-person .person-arm{position:absolute;left:54px;top:49px;width:10px;height:67px;border-radius:10px;background:#d79265;transform-origin:top center;}
.walking-person .person-arm.pointing{transform:rotate(-20deg);animation:personPointLoop 6s linear infinite;}
.walking-person .person-hand{position:absolute;left:91px;top:72px;width:14px;height:14px;border-radius:50%;background:#d79265;transform:scale(.9);animation:handPointLoop 6s linear infinite;}
.walking-person .person-leg{position:absolute;top:108px;width:13px;height:84px;border-radius:10px;background:#1d3658;transform-origin:top center;}
.walking-person .person-leg.left{left:23px;animation:walkLegLoopA .5s ease-in-out infinite;}
.walking-person .person-leg.right{left:48px;animation:walkLegLoopB .5s ease-in-out infinite;}
.walking-person .person-arm.back{left:16px;top:48px;height:63px;transform:rotate(25deg);animation:backArmLoop .5s ease-in-out infinite;}
.walking-person .person-shoe{position:absolute;width:27px;height:9px;border-radius:8px;background:#111;top:188px;}
.walking-person .shoe-left{left:14px}.walking-person .shoe-right{left:43px}
.walking-person .person-head{animation:personHeadBob .5s ease-in-out infinite}
.walking-person .person-body{animation:personBodyBob .5s ease-in-out infinite}
@keyframes personHeadBob{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-1px) rotate(1deg)}}
@keyframes personBodyBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes personWalkLoop{0%{left:-160px;transform:translateY(0)}10%{left:-115px;transform:translateY(-2px)}22%{left:-45px;transform:translateY(0)}38%{left:45px;transform:translateY(-2px)}52%{left:105px;transform:translateY(0)}60%{left:125px;transform:translateY(0)}72%{left:125px;transform:translateY(0)}84%{left:70px;transform:translateY(-2px)}94%{left:-20px;transform:translateY(0)}100%{left:-160px;transform:translateY(0)}}
@keyframes walkLegLoopA{0%,100%{transform:rotate(18deg)}50%{transform:rotate(-18deg)}}
@keyframes walkLegLoopB{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(18deg)}}
@keyframes backArmLoop{0%,100%{transform:rotate(25deg)}50%{transform:rotate(-12deg)}}
@keyframes personPointLoop{0%,55%{transform:rotate(-20deg)}60%,74%{transform:rotate(-72deg)}80%,100%{transform:rotate(-20deg)}}
@keyframes handPointLoop{0%,55%{left:91px;top:72px;transform:scale(.9)}60%,74%{left:102px;top:28px;transform:scale(1)}80%,100%{left:91px;top:72px;transform:scale(.9)}}
@media(max-width:760px){
 .walking-person{left:-130px;bottom:38px;transform:scale(.62);transform-origin:bottom left;animation:personWalkLoopMobile 6s linear infinite}
 .walking-person .person-arm.pointing{animation:personPointLoop 6s linear infinite}
 .walking-person .person-hand{animation:handPointLoop 6s linear infinite}
}
@keyframes personWalkLoopMobile{0%{left:-130px;transform:scale(.62) translateY(0)}10%{left:-92px;transform:scale(.62) translateY(-2px)}22%{left:-42px;transform:scale(.62) translateY(0)}38%{left:8px;transform:scale(.62) translateY(-2px)}52%{left:58px;transform:scale(.62) translateY(0)}60%,72%{left:72px;transform:scale(.62) translateY(0)}84%{left:38px;transform:scale(.62) translateY(-2px)}94%{left:-18px;transform:scale(.62) translateY(0)}100%{left:-130px;transform:scale(.62) translateY(0)}}
/* No second calculator/result input exists. */
.math-result-box{display:none!important}
.math-display-row{display:none!important}
.math-calc-buttons{display:none!important}
.math-captcha-box{display:none!important}
</style>
</head>
<body><div class="page-container"><img class="bg-image-hq" src="${backgroundImage}" alt=""><div class="content-area">
  <div class="header-section">
    <div class="qr-container">${qrImage ? `<div class="qr-code-box"><img src="${qrImage}" alt="QR Code"></div><div class="qr-text-code">${escPdf(currentQRLabel)}</div>` : ''}</div>
    <div class="barcode-box">${barcodeSvg || ''}</div>
    ${certificateStatus.bn ? `<div class="cert-status-box"><span class="bn-status">${escPdf(certificateStatus.bn)}</span> <span>${escPdf(certificateStatus.en)}</span></div>` : ''}
    <div class="header-container">
      <div class="gov-title">Government of the People's Republic of Bangladesh</div>
      <div class="office-title">Office of the Registrar, Birth and Death Registration</div>
      <div class="zone-title-1">${escPdf(regOffice)}</div>
      <div class="zone-title-2">${escPdf(localOffice)}</div>
      <div class="rule-title">(Rule 9, 10)</div>
    </div>
  </div>

  <div class="cert-title"><span class="bn-text cert-bn">${registrationMode === 'death' ? 'মৃত্যু নিবন্ধন সনদ' : 'জন্ম নিবন্ধন সনদ'}</span> <span class="cert-en">/</span> <span class="serif-text cert-en">${registrationMode === 'death' ? 'Death Registration Certificate' : 'Birth Registration Certificate'}</span></div>

  <table class="meta-table"><tr>
    <td style="width:30%;text-align:left">Date of Registration</td>
    <td style="width:40%;text-align:center;letter-spacing:.5px"><span class="serif-text reg-num-label">Birth Registration Number</span></td>
    <td style="width:30%;text-align:left;padding-left:12mm">Date of Issuance</td>
  </tr><tr class="meta-value-row">
    <td style="text-align:left">${escPdf(regDate)}</td>
    <td style="text-align:center;font-weight:bold"><span class="serif-text reg-num-value">${escPdf(brn)}</span></td>
    <td style="text-align:left;padding-left:12mm">${escPdf(issuanceDate)}</td>
  </tr></table>

  <table class="info-table">
    ${registrationMode === 'death' ? `
    <tr class="birth-date-row"><td style="width:18%;font-style:normal !important">Date of Birth</td><td class="colon-cell">:</td><td style="width:32%"><span class="dob-value-fix">${escPdf(birthDate)}</span></td><td colspan="2" style="width:50%;padding-left:26mm !important;padding-right:0 !important;vertical-align:top !important"><span class="sex-container sex-container-fixed">Sex :&nbsp;&nbsp;${escPdf(sex)}</span></td></tr>
    <tr class="death-date-row"><td style="width:18%;font-style:normal !important">Date of Death</td><td class="colon-cell">:</td><td colspan="3"><span class="dob-value-fix">${escPdf(dob)}</span></td></tr>` : `
    <tr class="dob-row"><td style="width:18%">Date of Birth</td><td class="colon-cell">:</td><td style="width:32%"><span class="dob-value-fix">${escPdf(dob)}</span></td><td colspan="2" style="width:50%;padding-left:26mm"><span class="sex-container">Sex :&nbsp;&nbsp;${escPdf(sex)}</span></td></tr>`}
    <tr class="img-row-fix"><td style="width:18%">In Word</td><td class="colon-cell">:</td><td colspan="3"><span class="inword-value-fix">${escPdf(inWord)}</span></td></tr>
    <tr><td class="label-bn-main">নাম</td><td class="colon-cell">:</td><td class="value-bn-main"><span class="value-bn-shift">${escPdf(nameBn)}</span></td><td class="label-en">Name</td><td class="value-en">:<span class="value-en-text">${escPdf(nameEn)}</span></td></tr>
    <tr><td class="label-bn-main">মাতা</td><td class="colon-cell">:</td><td class="value-bn-main"><span class="value-bn-shift">${escPdf(motherBn)}</span></td><td class="label-en">Mother</td><td class="value-en">:<span class="value-en-text">${escPdf(motherEn)}</span></td></tr>
    <tr><td class="label-bn-main">মাতার জাতীয়তা</td><td class="colon-cell">:</td><td class="value-bn-main"><span class="value-bn-shift">${escPdf(motherNatBn)}</span></td><td class="label-en">Nationality</td><td class="value-en">:<span class="value-en-text">${escPdf(motherNatEn)}</span></td></tr>
    <tr><td class="label-bn-main">পিতা</td><td class="colon-cell">:</td><td class="value-bn-main"><span class="value-bn-shift">${escPdf(fatherBn)}</span></td><td class="label-en">Father</td><td class="value-en">:<span class="value-en-text">${escPdf(fatherEn)}</span></td></tr>
    <tr><td class="label-bn-main">পিতার জাতীয়তা</td><td class="colon-cell">:</td><td class="value-bn-main"><span class="value-bn-shift">${escPdf(fatherNatBn)}</span></td><td class="label-en">Nationality</td><td class="value-en">:<span class="value-en-text">${escPdf(fatherNatEn)}</span></td></tr>
    <tr><td class="label-bn-main">জন্মস্থান</td><td class="colon-cell">:</td><td class="value-bn-main"><span class="value-bn-shift">${escPdf(pobBn)}</span></td><td class="label-en" style="white-space:nowrap">Place of Birth</td><td class="value-en">:<span class="value-en-text">${escPdf(pobEn)}</span></td></tr>
    ${registrationMode === 'death' ? `<tr class="address-row-shift"><td class="address-bn-font"><span style="display:inline-block;line-height:1.05">মৃত্যুর কারণ<br><small style="font-size:7pt;font-weight:normal;white-space:nowrap">(আই সি ডি ভার্সন অনুসারে)</small></span></td><td class="colon-cell">:</td><td class="value-bn-main" style="font-size:13pt !important"><span class="value-bn-shift" style="line-height:1.2;display:inline-block">${escPdf(deathCauseBn).replace(/\n/g,'<br>')}</span></td><td class="label-en" style="white-space:nowrap"><span style="display:inline-block;line-height:1.05">Cause of Death<br><small style="font-size:7pt;font-weight:normal;white-space:nowrap">(As Per ICD Version)</small></span></td><td class="value-en">:<span class="address-en-block">${escPdf(deathCauseEn)}</span></td></tr>` : `<tr class="address-row-shift"><td class="address-bn-font">স্থায়ী ঠিকানা</td><td class="colon-cell">:</td><td class="value-bn-main" style="font-size:13pt !important"><span class="value-bn-shift" style="line-height:1.2;display:inline-block">${escPdf(addrBn).replace(/\n/g,'<br>')}</span></td><td class="label-en">Permanent<br>Address</td><td class="value-en">:<span class="address-en-block">${escPdf(addrEn)}</span></td></tr>`}
  </table>

  ${selectedPDFImage ? `<div class="pdf-image-overlay"><img src="${escPdf(selectedPDFImage)}" alt="Selected PDF Image"></div>` : ''}

  <div class="footer-signatures"><table class="sig-table"><tr>
      <td class="sig-left-shift"><span class="sig-title">Seal &amp; Signature</span><br><span class="sig-bold-target">Assistant to Registrar</span><br><span class="sig-font-11">(Preparation, Verification)</span></td>
      <td class="sig-right-shift"><span class="sig-title">Seal &amp; Signature</span><br><span class="sig-bold-target">Registrar</span></td>
    </tr></table>
  </div>

  <div class="bottom-note">This certificate is generated from bdris.gov.bd, and to verify this certificate, please scan the above QR Code &amp; Bar Code.</div>
</div></div></body></html>`;

  try {
    const response = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({html: htmlContent})
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { const data = await response.json(); message = data?.error || message; } catch (_) {}
      throw new Error(message);
    }
    pdfBlob = await response.blob();
    if (!pdfBlob.size) throw new Error('PDF ফাইল খালি এসেছে।');
    if (pdfBlob.type !== 'application/pdf') pdfBlob = new Blob([pdfBlob], {type:'application/pdf'});
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(pdfBlob);
    // Preview the actual generated PDF so the complete A4 certificate is visible.
    // The old srcdoc preview only showed a clipped HTML viewport on mobile.
    const previewFrame = $("certIframe");
    if (previewFrame) {
      previewFrame.removeAttribute('src');
      previewFrame.srcdoc = buildInteractivePreviewHtml(htmlContent);
    }
    $("certPreview").style.display = 'block';
    
    if(saveHistory){
      try { await saveCurrentPDFToHistory(); } catch (historyError) { status('PDF তৈরি হয়েছে, কিন্তু History-তে সেভ করা যায়নি: ' + historyError.message, 'err'); }
    } else {
      pdfPreviewNeedsHistorySave = true;
    }
  } catch (e) {
    status('PDF তৈরি করতে ব্যর্থ: ' + e.message, 'err');
  }
}

function closeCertificatePreview(){
  const preview = $("certPreview");
  const frame = $("certIframe");
  if(frame){ frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; }
  if(preview) preview.style.display = 'none';
}

async function refreshUserBalance(){
  try{const r=await fetch('/api/balance');const d=await r.json();if(r.ok&&d.ok&&$('userBalance'))$('userBalance').textContent='৳'+Number(d.balance||0);}
  catch(_){}
}
async function chargeForPreview(){
  const r=await fetch('/api/balance/charge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:4})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.ok) throw new Error(d.error||'Balance charge failed');
  if($('userBalance'))$('userBalance').textContent='৳'+Number(d.balance||0);
  return d;
}
async function previewPDF(options={}){
  if(!options.skipCharge){
    try{ await chargeForPreview(); }catch(e){ status(e.message,'err'); await refreshUserBalance(); return; }
  }
  await generatePDF({saveHistory:false});
  setTimeout(()=>$('certPreview')?.scrollIntoView({behavior:'smooth',block:'start'}),80);
}

async function downloadPDF() {
  try {
    // Image editor changes live in the preview. Rebuild the real PDF only once, at download time.
    if(!pdfBlob || pdfPreviewNeedsHistorySave){
      await generatePDF({saveHistory:true});
    }
    if(!pdfBlob || !pdfBlob.size) throw new Error('PDF ফাইল তৈরি হয়নি।');
    pdfPreviewNeedsHistorySave=false;
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = 'Birth_Certificate.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch(e) {
    status('PDF download ব্যর্থ: '+e.message,'err');
  }
}

window.addEventListener('message',e=>{
  if(e.data?.type!=='pdf-image-editor-change')return;
  imagePositionX=Number(e.data.x)||0; imagePositionY=Number(e.data.y)||0;
  imageWidth=Math.max(20,Math.min(100,Number(e.data.w)||100)); imageHeight=Math.max(8,Math.min(100,Number(e.data.h)||100));
  imageZoom=Math.max(50,Math.min(300,Number(e.data.z)||100)); pdfPreviewNeedsHistorySave=true;
});
updatePDFImageAdjustUI();
updatePDFImageAdjustUI();
const deathDateInput=$('in_dob');
if(deathDateInput){ deathDateInput.addEventListener('input',()=>{ if(registrationMode==='death'){ const v=deathDateInput.value.trim(); $('in_inWord').value=v?dateToInWord(v):''; pdfPreviewNeedsHistorySave=true; } }); }
renderPDFHistory();
loadPDFImageLibrary();
refreshUserBalance();
setInterval(loadPDFImageLibrary, 15000);

// Make button handlers explicitly available to HTML onclick attributes.
Object.assign(window, {
  fetchCaptcha,
  clearForm,
  submitCaptcha,
  generateQRForCertificate,
  generatePDF,
  previewPDF,
  downloadPDF,
  setRegistrationMode,
  addPDFImageName,
  selectPDFImage,
  handlePDFImageUpload,
  resetPDFImageAdjust
});

