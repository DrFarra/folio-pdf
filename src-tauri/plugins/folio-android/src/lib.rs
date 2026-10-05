use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Manager, Runtime};
use serde_json::Value;
pub struct FolioAndroid<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> FolioAndroid<R> {
    pub fn call(&self, command: &str, args: Value) -> Result<Value, tauri::plugin::mobile::PluginInvokeError> { self.0.run_mobile_plugin(command, args) }
}
pub trait FolioAndroidExt<R: Runtime> { fn folio_android(&self) -> &FolioAndroid<R>; }
impl<R: Runtime, T: Manager<R>> FolioAndroidExt<R> for T {
    fn folio_android(&self) -> &FolioAndroid<R> { self.state::<FolioAndroid<R>>().inner() }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folio-android").setup(|app, api| {
        let handle = api.register_android_plugin("org.folio.android", "FolioPlugin")?;
        app.manage(FolioAndroid(handle)); Ok(())
    }).build()
}
