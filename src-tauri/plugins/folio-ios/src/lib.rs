use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Manager, Runtime};
use serde_json::Value;

tauri::ios_plugin_binding!(init_plugin_folio_ios);

pub struct FolioIos<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> FolioIos<R> {
    pub fn call(&self, command: &str, args: Value) -> Result<Value, tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin(command, args)
    }
}
pub trait FolioIosExt<R: Runtime> {
    fn folio_ios(&self) -> &FolioIos<R>;
}
impl<R: Runtime, T: Manager<R>> FolioIosExt<R> for T {
    fn folio_ios(&self) -> &FolioIos<R> { self.state::<FolioIos<R>>().inner() }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folio-ios").setup(|app, api| {
        let handle = api.register_ios_plugin(init_plugin_folio_ios)?;
        app.manage(FolioIos(handle));
        Ok(())
    }).build()
}
