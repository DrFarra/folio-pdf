//! Drive owns remote versions; immutable local files keep open readers stable.
//! Every upload is journaled before network I/O and uses an HTTP precondition.
use crate::{Desktop, DocumentInfo, register, drive_auth};
use md5::{Digest, Md5};
use reqwest::{blocking::{Client, Response, Body}, header, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, State};

const API: &str = "https://www.googleapis.com/drive/v2";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v2";
const FIELDS: &str = "id,title,mimeType,etag,md5Checksum,fileSize,modifiedDate,parents(id),labels(trashed),editable,properties(key,value,visibility)";
const OFFLINE: &str = "No se pudo conectar con Google Drive. Tu edición sigue guardada en este dispositivo.";

#[derive(Default)]
pub struct DriveState(Mutex<Option<drive_auth::Token>>);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Account { id: String, email: String, name: String }
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct Remote {
    id: String, title: String, mime_type: String, etag: String,
    #[serde(default)] md5_checksum: String,
    #[serde(default)] file_size: String,
    #[serde(default)] modified_date: String,
    #[serde(default)] editable: bool,
    #[serde(default)] parents: Vec<Value>,
    #[serde(default)] labels: Value,
    #[serde(default)] properties: Vec<Value>,
}
impl Remote {
    fn size(&self) -> u64 { self.file_size.parse().unwrap_or(0) }
    fn property(&self, key:&str) -> Option<&str> { self.properties.iter().find(|p|p["key"]==key).and_then(|p|p["value"].as_str()) }
    fn pdf(&self) -> Result<(),String> {
        if self.labels["trashed"]==true { return Err("El PDF está en la papelera de Drive.".into()); }
        if self.mime_type!="application/pdf" { return Err("Selecciona un documento PDF.".into()); }
        if self.md5_checksum.len()!=32 || self.etag.is_empty() || self.size()==0 { return Err("Drive no proporcionó una versión verificable del PDF.".into()); }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Binding { id:String, account:Account, remote:Remote, path:PathBuf }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Pending { id:String, binding:String, account:String, file_id:String, name:String, created:u64, checksum:String, size:u64, path:PathBuf, #[serde(default)] copy_id:Option<String> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Opened { document:DocumentInfo, binding:String, account:String, file_id:String, base_checksum:String, offline:bool, transferred:u64, editable:bool }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Synced { status:String, opened:Option<Opened>, message:String }

fn ioerr(_:impl std::fmt::Display)->String { "No se pudo guardar la copia local de Drive. Comprueba el espacio disponible.".into() }
fn root(desktop:&Desktop)->PathBuf { desktop.data.join("drive") }
fn key(s:&str)->String { folio_core::digest(s.as_bytes()) }
fn safe_id(id:&str)->Result<(),String> { if id.is_empty() || !id.bytes().all(|c|c.is_ascii_alphanumeric() || b"-_".contains(&c)) { Err("Identificador de Drive inválido.".into()) } else { Ok(()) } }
fn json_read<T:serde::de::DeserializeOwned>(p:&Path)->Result<T,String> { serde_json::from_slice(&fs::read(p).map_err(ioerr)?).map_err(|_|"El registro local de Drive no es válido.".into()) }
fn json_write(p:&Path, v:&impl Serialize)->Result<(),String> {
    fs::create_dir_all(p.parent().ok_or("Carpeta de Drive inválida.")?).map_err(ioerr)?;
    let bytes=serde_json::to_vec(v).map_err(ioerr)?;
    folio_core::atomic_write(p,&bytes,folio_core::fingerprint(p)?.as_deref())
}
fn binding_path(d:&Desktop,id:&str)->Result<PathBuf,String> { safe_id(id)?;Ok(root(d).join("bindings").join(format!("{id}.json"))) }
fn pending_path(d:&Desktop,id:&str)->Result<PathBuf,String> { safe_id(id)?;Ok(root(d).join("pending").join(format!("{id}.json"))) }
fn account(d:&Desktop)->Result<Account,String> { json_read(&root(d).join("account.json")).map_err(|_|"Inicia sesión con Google Drive.".into()) }
fn http()->Result<Client,String> { Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(1800)).redirect(reqwest::redirect::Policy::limited(5)).build().map_err(|_|"No se pudo iniciar la conexión segura.".into()) }
fn response(r:Response)->Result<Response,String> {
    match r.status() {
        StatusCode::UNAUTHORIZED=>Err("La sesión de Google venció. Vuelve a conectar Drive.".into()),
        StatusCode::FORBIDDEN=>Err("Google Drive denegó el acceso. Comprueba los permisos y el espacio de tu cuenta.".into()),
        StatusCode::NOT_FOUND=>Err("El archivo ya no está disponible en Drive o perdiste el acceso.".into()),
        StatusCode::PRECONDITION_FAILED=>Err("CONFLICT".into()),
        s if s.is_success()=>Ok(r),
        StatusCode::TOO_MANY_REQUESTS=>Err("Google Drive está limitando las solicitudes. Reintenta en unos minutos.".into()),
        _=>Err("Google Drive no completó la operación. Tu copia local está conservada.".into())
    }
}
fn metadata(c:&Client,t:&str,id:&str)->Result<Remote,String> {
    safe_id(id)?;
    response(c.get(format!("{API}/files/{id}")).bearer_auth(t).query(&[("fields",FIELDS),("supportsAllDrives","true")]).send().map_err(|_|OFFLINE)?)?.json().map_err(|_|"Drive devolvió metadatos incompletos.".into())
}
fn identity(c:&Client,t:&str)->Result<Account,String> {
    let v:Value=response(c.get("https://www.googleapis.com/drive/v3/about").bearer_auth(t).query(&[("fields","user(permissionId,emailAddress,displayName)")]).send().map_err(|_|OFFLINE)?)?.json().map_err(|_|"No se pudo comprobar la cuenta de Google.")?;
    Ok(Account { id:v["user"]["permissionId"].as_str().ok_or("Google no identificó la cuenta.")?.into(),email:v["user"]["emailAddress"].as_str().unwrap_or("").into(),name:v["user"]["displayName"].as_str().unwrap_or("Google Drive").into() })
}
fn access(app:&tauri::AppHandle,c:&Client,guard:&mut Option<drive_auth::Token>, expected:&Account)->Result<String,String> {
    if guard.as_ref().is_none_or(|t|t.until<=Instant::now()) {
        let new=drive_auth::token(app,c,false)?;
        let actual=identity(c,&new.access)?;
        if actual.id!=expected.id { return Err("La cuenta de Google cambió. Conecta la cuenta original antes de sincronizar este PDF.".into()); }
        *guard=Some(new);
    }
    Ok(guard.as_ref().unwrap().access.clone())
}
fn checksum(path:&Path)->Result<(String,u64),String> {
    let mut f=fs::File::open(path).map_err(ioerr)?; let mut digest=Md5::new();let mut total=0;let mut buffer=[0u8;262144];
    loop { let n=f.read(&mut buffer).map_err(ioerr)?;if n==0 {break;} digest.update(&buffer[..n]);total+=n as u64; }
    Ok((format!("{:x}",digest.finalize()),total))
}
fn prefix_equal(old:&Path,new:&Path)->Result<bool,String> {
    let mut a=fs::File::open(old).map_err(ioerr)?;let mut b=fs::File::open(new).map_err(ioerr)?;
    if a.metadata().map_err(ioerr)?.len()>=b.metadata().map_err(ioerr)?.len() {return Ok(false);}
    let mut x=[0;262144];let mut y=[0;262144];
    loop {let n=a.read(&mut x).map_err(ioerr)?;if n==0{return Ok(true);} b.read_exact(&mut y[..n]).map_err(ioerr)?;if x[..n]!=y[..n]{return Ok(false);} }
}
fn cache_path(d:&Desktop,a:&Account,id:&str)->PathBuf {root(d).join("cache").join(key(&format!("{}:{id}",a.id))).with_extension("json")}
fn opened(d:&Desktop,b:&Binding,offline:bool,transferred:u64)->Result<Opened,String> {
    let mut document=register(d,b.path.clone())?; document.name=b.remote.title.clone();
    // The title is metadata; it must never become an unchecked filesystem path.
    if let Some(source)=d.files.lock().map_err(|_|"Archivos ocupados.")?.sources.get_mut(&document.token) {source.info.name=document.name.clone();}
    Ok(Opened{document,binding:b.id.clone(),account:b.account.id.clone(),file_id:b.remote.id.clone(),base_checksum:b.remote.md5_checksum.clone(),offline,transferred,editable:b.remote.editable})
}
fn delta_base(local:&Remote,remote:&Remote)->bool {
    let direct=remote.property("folioBaseMd5")==Some(local.md5_checksum.as_str()) && remote.property("folioBaseSize")==Some(local.file_size.as_str());
    let ancestor=format!("{}:{}",local.md5_checksum,local.file_size);
    let historical=(0..16).any(|n|remote.property(&format!("folioBase{n:02}"))==Some(ancestor.as_str()));
    (direct || historical) && remote.property("folioResultMd5")==Some(remote.md5_checksum.as_str()) && remote.size()>local.size()
}
fn download(c:&Client,t:&str,d:&Desktop,a:&Account,remote:Remote,cache:Option<Binding>)->Result<Opened,String> {
    remote.pdf()?;
    let valid=cache.filter(|b|b.account.id==a.id && b.remote.id==remote.id && checksum(&b.path).ok()==Some((b.remote.md5_checksum.clone(),b.remote.size())));
    if let Some(old)=&valid { if old.remote.md5_checksum==remote.md5_checksum {
        let b=Binding{id:uuid::Uuid::new_v4().to_string(),account:a.clone(),remote,path:old.path.clone()};
        json_write(&binding_path(d,&b.id)?,&b)?;json_write(&cache_path(d,a,&b.remote.id),&b)?;return opened(d,&b,false,0);
    } }
    let id=uuid::Uuid::new_v4().to_string(); let path=root(d).join("files").join(format!("{id}.pdf"));
    fs::create_dir_all(path.parent().unwrap()).map_err(ioerr)?;
    let mut transferred=0;
    let result=(|| {
        let suffix=valid.as_ref().filter(|b|delta_base(&b.remote,&remote));
        // A media representation has a different ETag from metadata in Drive.
        // Verify the complete checksum against the captured metadata instead.
        let mut request=c.get(format!("{API}/files/{}",remote.id)).bearer_auth(t).query(&[("alt","media"),("supportsAllDrives","true")]);
        if let Some(old)=suffix {request=request.header(header::RANGE,format!("bytes={}-",old.remote.size()));}
        let mut r=response(request.send().map_err(|_|OFFLINE)?)?;
        let mut target=fs::File::create(&path).map_err(ioerr)?;
        if let Some(old)=suffix { if r.status()==StatusCode::PARTIAL_CONTENT {
            let expected=format!("bytes {}-{}/{}",old.remote.size(),remote.size()-1,remote.size());
            if r.headers().get(header::CONTENT_RANGE).and_then(|v|v.to_str().ok())!=Some(&expected) {return Err("Drive devolvió un rango diferente. Reintenta la descarga.".into());}
            std::io::copy(&mut fs::File::open(&old.path).map_err(ioerr)?,&mut target).map_err(ioerr)?;
        } else if r.status()!=StatusCode::OK {return Err("Respuesta de descarga inválida.".into());} }
        transferred=std::io::copy(&mut r,&mut target).map_err(|_|OFFLINE)?;target.sync_all().map_err(ioerr)?;drop(target);
        if checksum(&path)?!=(remote.md5_checksum.clone(),remote.size()) {return Err("La descarga cambió o quedó incompleta. Reintenta; la copia anterior está intacta.".into());}
        folio_core::inspect_pdf_file(&path)?;
        let b=Binding{id,account:a.clone(),remote,path:path.clone()};
        json_write(&binding_path(d,&b.id)?,&b)?;json_write(&cache_path(d,a,&b.remote.id),&b)?;opened(d,&b,false,transferred)
    })();
    if result.is_err(){let _=fs::remove_file(path);} result
}

// All Drive mutations on one device are serialized. Across devices the server
// enforces If-Match; a local mutex or a GET-before-PUT is not a remote lock.
async fn work<T:Send+'static>(app:tauri::AppHandle,f:impl FnOnce(&tauri::AppHandle,&Desktop,&Client,&mut Option<drive_auth::Token>)->Result<T,String>+Send+'static)->Result<T,String> {
    tauri::async_runtime::spawn_blocking(move|| {
        let d=app.state::<Desktop>();let state=app.state::<DriveState>();
        let mut guard=state.0.lock().map_err(|_|"Google Drive está ocupado.")?;
        f(&app,&d,&http()?,&mut guard)
    }).await.map_err(|_|"La operación de Drive se interrumpió. Tu copia está conservada.".to_string())?
}
#[tauri::command]
pub async fn drive_status(app:tauri::AppHandle)->Result<Value,String> {
    work(app,|_,d,_,_| {let a=account(d).ok();let pending=queue(d,a.as_ref().map(|a|a.id.as_str()))?;Ok(json!({"account":a,"pending":pending}))}).await
}
#[tauri::command]
pub async fn drive_connect(app:tauri::AppHandle)->Result<Account,String> {
    work(app,|app,d,c,g| {let token=drive_auth::token(app,c,true)?;let a=identity(c,&token.access)?;json_write(&root(d).join("account.json"),&a)?;*g=Some(token);Ok(a)}).await
}
#[tauri::command]
pub async fn drive_disconnect(app:tauri::AppHandle)->Result<(),String> {
    work(app,|app,d,_,g| {drive_auth::disconnect(app)?;*g=None;let p=root(d).join("account.json");if p.exists(){fs::remove_file(p).map_err(ioerr)?;}Ok(())}).await
}
#[tauri::command]
pub async fn drive_list(app:tauri::AppHandle,folder:String,page_token:Option<String>,search:Option<String>)->Result<Value,String> {
    work(app,move|app,d,c,g| {
        let a=account(d)?;let t=access(app,c,g,&a)?;safe_id(&folder)?;
        let mut q=if folder=="shared" {"sharedWithMe and trashed = false".to_string()} else {format!("'{folder}' in parents and trashed = false")};
        q.push_str(" and (mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.folder')");
        if let Some(search)=search.filter(|s|!s.trim().is_empty()) { let search=search.replace('\\',"\\\\").replace('\'',"\\'");q.push_str(&format!(" and title contains '{search}'")); }
        let value:Value=response(c.get(format!("{API}/files")).bearer_auth(t).query(&[("q",q.as_str()),("maxResults","100"),("pageToken",page_token.as_deref().unwrap_or("")),("orderBy","folder,title_natural"),("supportsAllDrives","true"),("includeItemsFromAllDrives","true"),("fields","nextPageToken,items(id,title,mimeType,fileSize,modifiedDate,editable)")]).send().map_err(|_|OFFLINE)?)?.json().map_err(|_|"No se pudo leer la carpeta.")?;
        Ok(value)
    }).await
}
#[tauri::command]
pub async fn drive_open(app:tauri::AppHandle,file_id:String,offline:Option<bool>)->Result<Opened,String> {
    work(app,move|app,d,c,g| {
        safe_id(&file_id)?;let a=account(d)?;let cached:Option<Binding>=json_read(&cache_path(d,&a,&file_id)).ok();
        if offline==Some(true) {let b=cached.ok_or("Este PDF todavía no está descargado en el dispositivo.")?;if checksum(&b.path)?!=(b.remote.md5_checksum.clone(),b.remote.size()){return Err("La copia local está dañada. Descárgala de nuevo.".into());}return opened(d,&b,true,0);}
        let t=access(app,c,g,&a)?;let remote=metadata(c,&t,&file_id)?;download(c,&t,d,&a,remote,cached)
    }).await
}
#[tauri::command]
pub async fn drive_cached(app:tauri::AppHandle)->Result<Value,String> {
    work(app,|_,d,_,_| {
        let a=account(d)?;let mut items=vec![];
        if let Ok(dir)=fs::read_dir(root(d).join("cache")) {for p in dir.flatten() {if let Ok(b)=json_read::<Binding>(&p.path()){if b.account.id==a.id && b.path.is_file(){items.push(json!({"id":b.remote.id,"title":b.remote.title,"mimeType":"application/pdf","fileSize":b.remote.file_size}));}}}}
        Ok(json!({"items":items}))
    }).await
}
#[tauri::command]
pub async fn drive_lookup(app:tauri::AppHandle,token:String)->Result<Option<Value>,String> {
    work(app,move|_,d,_,_| {
        let path=d.files.lock().map_err(|_|"Archivos ocupados.")?.sources.get(&token).map(|s|s.path.clone());let Some(path)=path else{return Ok(None)};
        if let Ok(dir)=fs::read_dir(root(d).join("bindings")){for p in dir.flatten(){if let Ok(b)=json_read::<Binding>(&p.path()){if b.path==path{return Ok(Some(json!({"binding":b.id,"account":b.account.id,"fileId":b.remote.id,"baseChecksum":b.remote.md5_checksum,"editable":b.remote.editable})));}}}}
        if let Ok(dir)=fs::read_dir(root(d).join("pending")){for entry in dir.flatten(){if let Ok(p)=json_read::<Pending>(&entry.path()){if p.path==path{let b:Binding=json_read(&binding_path(d,&p.binding)?)?;return Ok(Some(json!({"binding":b.id,"account":b.account.id,"fileId":b.remote.id,"baseChecksum":b.remote.md5_checksum,"editable":b.remote.editable})));}}}}
        if path.starts_with(root(d)) {return Err("No se pudo recuperar el vínculo de este PDF con Drive. Ábrelo desde Google Drive o desde Ediciones pendientes.".into());}
        Ok(None)
    }).await
}
fn stage(d:&Desktop,binding:String,path:PathBuf)->Result<Pending,String> {
    let b:Binding=json_read(&binding_path(d,&binding)?)?;if !b.remote.editable{return Err("Este PDF tiene permiso de solo lectura en Drive.".into());}
    let (hash,size)=checksum(&path)?;folio_core::inspect_pdf_file(&path)?;
    if let Some(existing)=queue(d,Some(&b.account.id))?.into_iter().find(|p|p.binding==binding && p.checksum==hash && p.size==size && checksum(&p.path).ok()==Some((hash.clone(),size))) { if path!=existing.path{let _=fs::remove_file(path);}return Ok(existing); }
    let p=Pending{id:uuid::Uuid::new_v4().to_string(),binding,account:b.account.id,file_id:b.remote.id,name:b.remote.title,created:SystemTime::now().duration_since(UNIX_EPOCH).map_err(ioerr)?.as_millis() as u64,checksum:hash,size,path,copy_id:None};
    json_write(&pending_path(d,&p.id)?,&p)?;Ok(p)
}
#[tauri::command]
pub fn drive_stage(request:tauri::ipc::Request<'_>,desktop:State<'_,Desktop>)->Result<Pending,String> {
    let binding=request.headers().get("x-folio-drive-binding").and_then(|h|h.to_str().ok()).ok_or("No se identificó el archivo de Drive.")?.to_string();
    let _:Binding=json_read(&binding_path(&desktop,&binding)?)?;
    let bytes = crate::binary_ipc::bytes(request.body())?;folio_core::validate_pdf(&bytes)?;
    let path=root(&desktop).join("edits").join(format!("{}.pdf",uuid::Uuid::new_v4()));fs::create_dir_all(path.parent().unwrap()).map_err(ioerr)?;
    folio_core::atomic_write(&path,&bytes,None)?;stage(&desktop,binding,path)
}
fn queue(d:&Desktop,a:Option<&str>)->Result<Vec<Pending>,String> {
    let mut result=vec![];if let Ok(dir)=fs::read_dir(root(d).join("pending")){for p in dir.flatten(){if let Ok(p)=json_read::<Pending>(&p.path()){if a==Some(p.account.as_str()){result.push(p);}}}}
    result.sort_by_key(|p|p.created);Ok(result)
}

#[tauri::command]
pub async fn drive_stage_native(app:tauri::AppHandle,binding:String,token:String,annotations:Value,removed_source_refs:Vec<String>)->Result<Pending,String> {
    work(app,move|app,d,_,_| {
        #[cfg(target_os="ios")]
        {
            use tauri_plugin_folio_ios::FolioIosExt;
            let _:Binding=json_read(&binding_path(d,&binding)?)?;
            if !annotations.is_array() || annotations.to_string().len()>4*1024*1024{return Err("Las anotaciones son demasiado grandes.".into());}
            if !d.files.lock().map_err(|_|"Archivos ocupados.")?.sources.contains_key(&token){return Err("El documento nativo no está abierto.".into());}
            let path=root(d).join("edits").join(format!("{}.pdf",uuid::Uuid::new_v4()));fs::create_dir_all(path.parent().unwrap()).map_err(ioerr)?;
            app.folio_ios().call("pdfExport",json!({"token":token,"path":path,"annotations":annotations,"removedSourceRefs":removed_source_refs})).map_err(|_|"No se pudo preparar la edición nativa de Drive.".to_string())?;
            stage(d,binding,path)
        }
        #[cfg(not(target_os="ios"))]
        {let _=(app,d,binding,token,annotations,removed_source_refs);Err("Usa el guardado del lector PDF de este dispositivo.".into())}
    }).await
}

fn upload(c:&Client,t:&str,p:&Pending,base:&Binding,remote:&Remote,copy_id:Option<&str>)->Result<Remote,String> {
    let boundary=format!("folio{}",uuid::Uuid::new_v4().simple());
    let incremental=copy_id.is_none() && prefix_equal(&base.path,&p.path)?;
    let mut props=vec![json!({"key":"folioResultMd5","value":p.checksum,"visibility":"PUBLIC"})];
    let mut ancestors=vec![];
    if incremental {
        ancestors.push(format!("{}:{}",base.remote.md5_checksum,base.remote.file_size));
        if base.remote.property("folioResultMd5")==Some(base.remote.md5_checksum.as_str()) {
            for n in 0..15 {if let Some(value)=base.remote.property(&format!("folioBase{n:02}")){ancestors.push(value.to_string());}}
        }
    }
    // Clear unused entries as well: a later full rewrite must invalidate every
    // historical prefix. At most 17 small public properties, shared across the
    // three native OAuth clients, describe the latest verified byte ancestry.
    for n in 0..16 {props.push(json!({"key":format!("folioBase{n:02}"),"value":ancestors.get(n).map(String::as_str).unwrap_or(""),"visibility":"PUBLIC"}));}
    let mut meta=json!({"properties":props});
    if let Some(id)=copy_id {meta["id"]=json!(id);meta["title"]=json!(format!("{} — conflicto {}.pdf",p.name.trim_end_matches(".pdf"),p.created));meta["mimeType"]=json!("application/pdf");meta["parents"]=json!(remote.parents);}
    let prefix=format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/pdf\r\n\r\n").into_bytes();
    let suffix=format!("\r\n--{boundary}--\r\n").into_bytes();let size=prefix.len() as u64+p.size+suffix.len() as u64;
    let reader=std::io::Cursor::new(prefix).chain(fs::File::open(&p.path).map_err(ioerr)?).chain(std::io::Cursor::new(suffix));
    let request=if copy_id.is_some(){c.post(format!("{UPLOAD}/files"))}else{c.put(format!("{UPLOAD}/files/{}",remote.id)).header(header::IF_MATCH,&remote.etag)};
    let r=request.bearer_auth(t).query(&[("uploadType","multipart"),("supportsAllDrives","true"),("fields",FIELDS)]).header(header::CONTENT_TYPE,format!("multipart/related; boundary={boundary}")).body(Body::sized(reader,size)).send().map_err(|_|OFFLINE)?;
    response(r)?.json().map_err(|_|"No se pudo confirmar el guardado. Reintenta para comprobarlo sin duplicarlo.".into())
}
fn completed(d:&Desktop,p:&Pending,remote:Remote)->Result<Synced,String> {
    if remote.md5_checksum!=p.checksum || remote.size()!=p.size {return Err("Drive no confirmó los mismos bytes. La edición local sigue conservada.".into());}
    let a=account(d)?;let b=Binding{id:uuid::Uuid::new_v4().to_string(),account:a,remote,path:p.path.clone()};
    json_write(&binding_path(d,&b.id)?,&b)?;json_write(&cache_path(d,&b.account,&b.remote.id),&b)?;
    let result=opened(d,&b,false,0)?;fs::remove_file(pending_path(d,&p.id)?).map_err(ioerr)?;
    Ok(Synced{status:"saved".into(),opened:Some(result),message:if p.copy_id.is_some(){"Se guardó una copia de conflicto. El original de Drive sigue intacto."}else{"PDF guardado en Google Drive."}.into()})
}
#[tauri::command]
pub async fn drive_sync(app:tauri::AppHandle,id:String,conflict_copy:Option<bool>)->Result<Synced,String> {
    work(app,move|app,d,c,g| {
        let mut p:Pending=json_read(&pending_path(d,&id)?)?;let b:Binding=json_read(&binding_path(d,&p.binding)?)?;let a=account(d)?;
        if p.account!=a.id {return Err("Conecta la cuenta original para sincronizar este cambio.".into());}
        if checksum(&p.path)?!=(p.checksum.clone(),p.size){return Err("La edición pendiente cambió o está dañada. No se subió ningún archivo.".into());}
        let t=access(app,c,g,&a)?;
        if let Some(copy)=&p.copy_id {if let Ok(remote)=metadata(c,&t,copy){return completed(d,&p,remote);}}
        let remote=metadata(c,&t,&p.file_id)?;remote.pdf()?;
        if remote.md5_checksum==p.checksum && remote.size()==p.size && p.copy_id.is_none(){return completed(d,&p,remote);}
        let conflict=remote.md5_checksum!=b.remote.md5_checksum;
        if conflict_copy==Some(true) && p.copy_id.is_none() {
            let ids:Value=response(c.get(format!("{API}/files/generateIds")).bearer_auth(&t).query(&[("maxResults","1")]).send().map_err(|_|OFFLINE)?)?.json().map_err(|_|"No se pudo preparar la copia.")?;
            p.copy_id=Some(ids["ids"][0].as_str().ok_or("Drive no asignó un identificador.")?.into());json_write(&pending_path(d,&p.id)?,&p)?;
        }
        if conflict && p.copy_id.is_none(){return Ok(Synced{status:"conflict".into(),opened:None,message:"Otro dispositivo modificó este PDF. Tu edición está conservada. Puedes guardarla como una copia y comparar ambas versiones.".into()});}
        if !remote.editable && p.copy_id.is_none(){return Err("Ya no tienes permiso para editar el original. Tu cambio sigue conservado.".into());}
        match upload(c,&t,&p,&b,&remote,p.copy_id.as_deref()) {
            Ok(saved)=>completed(d,&p,saved),
            Err(e) if e=="CONFLICT"=>Ok(Synced{status:"conflict".into(),opened:None,message:"El archivo cambió durante el guardado. Tu edición está conservada; el original no fue reemplazado.".into()}),
            Err(e)=>Err(e)
        }
    }).await
}
#[tauri::command]
pub async fn drive_pending_open(app:tauri::AppHandle,id:String)->Result<Opened,String> {
    work(app,move|_,d,_,_|{let p:Pending=json_read(&pending_path(d,&id)?)?;let mut b:Binding=json_read(&binding_path(d,&p.binding)?)?;if account(d)?.id!=p.account{return Err("Conecta la cuenta original.".into());}b.path=p.path;b.remote.title=p.name;opened(d,&b,true,0)}).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn remote(hash:&str,size:u64)->Remote {serde_json::from_value(json!({"id":"file","title":"test.pdf","mimeType":"application/pdf","etag":"v1","md5Checksum":hash,"fileSize":size.to_string()})).unwrap()}
    #[test] fn suffix_requires_verified_base_and_current_result(){
        let a=remote(&"a".repeat(32),100);let mut b=remote(&"b".repeat(32),120);
        assert!(!delta_base(&a,&b));b.properties=vec![json!({"key":"folioBaseMd5","value":a.md5_checksum}),json!({"key":"folioBaseSize","value":"100"}),json!({"key":"folioResultMd5","value":b.md5_checksum})];assert!(delta_base(&a,&b));
        b.md5_checksum="c".repeat(32);assert!(!delta_base(&a,&b));
    }
    #[test] fn ids_cannot_escape_storage(){for s in ["../file","file/x","a'b","a\\b",""]{assert!(safe_id(s).is_err());}assert!(safe_id("1AB_-xy").is_ok());}
    #[test] fn prefix_test_detects_rewrites(){let dir=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());fs::create_dir_all(&dir).unwrap();let a=dir.join("a");let b=dir.join("b");fs::write(&a,b"base").unwrap();fs::write(&b,b"base-more").unwrap();assert!(prefix_equal(&a,&b).unwrap());fs::write(&b,b"rewrite-more").unwrap();assert!(!prefix_equal(&a,&b).unwrap());fs::remove_dir_all(dir).unwrap();}

    #[test]
    #[ignore = "Requires explicit FOLIO_DRIVE_TEST_TOKEN and creates only a disposable Folio test PDF"]
    fn live_roundtrip_and_conflict() {
        let token=fs::read_to_string(std::env::var("FOLIO_DRIVE_TEST_TOKEN").unwrap()).unwrap();let c=http().unwrap();
        let a=identity(&c,token.trim()).unwrap();
        let data=std::env::temp_dir().join(format!("folio-drive-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&data).unwrap();
        let d=Desktop{data:data.clone(),files:Mutex::new(crate::Files::default()),store:Mutex::new(())};json_write(&root(&d).join("account.json"),&a).unwrap();
        let created:Value=response(c.post(format!("{API}/files")).bearer_auth(token.trim()).json(&json!({"title":"Folio — prueba automática de sincronización.pdf","mimeType":"application/pdf"})).send().unwrap()).unwrap().json().unwrap();
        let id=created["id"].as_str().unwrap().to_string();
        let mut conflict_copy=None;
        let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let base=include_bytes!("../../public/sample.pdf");
            response(c.put(format!("{UPLOAD}/files/{id}")).bearer_auth(token.trim()).query(&[("uploadType","media")]).header(header::CONTENT_TYPE,"application/pdf").body(base.to_vec()).send().unwrap()).unwrap();
            let remote=metadata(&c,token.trim(),&id).unwrap();
            let first=download(&c,token.trim(),&d,&a,remote.clone(),None).unwrap();assert_eq!(first.transferred,base.len() as u64);
            let b:Binding=json_read(&binding_path(&d,&first.binding).unwrap()).unwrap();
            let edit=PathBuf::from(std::env::var("FOLIO_DRIVE_TEST_PDF").unwrap());let p=stage(&d,b.id.clone(),edit).unwrap();
            let uploaded=upload(&c,token.trim(),&p,&b,&remote,None).unwrap();assert_eq!(uploaded.id,id);assert_eq!(uploaded.md5_checksum,p.checksum);
            assert_eq!(upload(&c,token.trim(),&p,&b,&remote,None).unwrap_err(),"CONFLICT");
            let fresh=metadata(&c,token.trim(),&id).unwrap();assert!(delta_base(&b.remote,&fresh));
            let partial=download(&c,token.trim(),&d,&a,fresh.clone(),Some(b.clone())).unwrap();assert_eq!(partial.transferred,p.size-base.len() as u64);
            let cached:Binding=json_read(&binding_path(&d,&partial.binding).unwrap()).unwrap();
            let warm=download(&c,token.trim(),&d,&a,fresh.clone(),Some(cached.clone())).unwrap();assert_eq!(warm.transferred,0);
            // An external rewrite invalidates the ancestry, even if old custom
            // properties survive. It cannot be mistaken for a suffix update.
            response(c.put(format!("{UPLOAD}/files/{id}")).bearer_auth(token.trim()).query(&[("uploadType","media")]).header(header::CONTENT_TYPE,"application/pdf").body(base.to_vec()).send().unwrap()).unwrap();
            let external=metadata(&c,token.trim(),&id).unwrap();assert!(!delta_base(&cached.remote,&external));
            let full=download(&c,token.trim(),&d,&a,external.clone(),Some(cached)).unwrap();assert_eq!(full.transferred,base.len() as u64);
            assert!(pending_path(&d,&p.id).unwrap().exists(),"Rejected upload must preserve the journal");
            let second_path=p.path.with_file_name("concurrent.pdf");
            let (second_hash,second_size)=checksum(&second_path).unwrap();
            let second=Pending{path:second_path,checksum:second_hash,size:second_size,..p.clone()};
            assert_ne!(p.checksum,second.checksum);
            let barrier=std::sync::Barrier::new(2);
            let outcomes=std::thread::scope(|s| {
                let left=s.spawn(|| {barrier.wait();upload(&c,token.trim(),&p,&b,&external,None)});
                let right=s.spawn(|| {barrier.wait();upload(&c,token.trim(),&second,&b,&external,None)});
                [left.join().unwrap(),right.join().unwrap()]
            });
            assert_eq!(outcomes.iter().filter(|v|v.is_ok()).count(),1,"Exactly one concurrent writer may replace the original");
            assert_eq!(outcomes.iter().filter(|v|matches!(v,Err(e) if e=="CONFLICT")).count(),1);
            let current=metadata(&c,token.trim(),&id).unwrap();assert!(current.md5_checksum==p.checksum||current.md5_checksum==second.checksum);
            let generated:Value=response(c.get(format!("{API}/files/generateIds")).bearer_auth(token.trim()).query(&[("maxResults","1")]).send().unwrap()).unwrap().json().unwrap();
            let copy=generated["ids"][0].as_str().unwrap().to_string();conflict_copy=Some(copy.clone());
            let copied=upload(&c,token.trim(),&p,&b,&current,Some(&copy)).unwrap();assert_eq!(copied.id,copy);assert_eq!(copied.parents,current.parents);assert_eq!(copied.md5_checksum,p.checksum);
            assert_eq!(metadata(&c,token.trim(),&id).unwrap().md5_checksum,current.md5_checksum,"Conflict copy must not replace the original");
            assert_eq!(completed(&d,&p,copied).unwrap().status,"saved");assert!(!pending_path(&d,&p.id).unwrap().exists());
        }));
        let trashed=c.post(format!("{API}/files/{id}/trash")).bearer_auth(token.trim()).json(&json!({})).send().unwrap();assert!(trashed.status().is_success(),"Clean up disposable test by moving it to Trash");
        if let Some(copy)=conflict_copy {let response=c.post(format!("{API}/files/{copy}/trash")).bearer_auth(token.trim()).json(&json!({})).send().unwrap();assert!(response.status().is_success());}
        fs::remove_dir_all(data).unwrap();if let Err(panic)=result{std::panic::resume_unwind(panic);}
    }
}
