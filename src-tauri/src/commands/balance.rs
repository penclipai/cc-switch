use crate::provider::UsageResult;

#[tauri::command]
pub async fn get_balance(base_url: String, api_key: String) -> Result<UsageResult, String> {
    let resolved_api_key = crate::services::api_key_vars::resolve::resolve_value(&api_key)
        .map_err(|e| e.to_string())?
        .into_owned();
    let credential_use = crate::services::api_key_vars::unauthorized::CredentialUse::capture(
        &api_key,
        &resolved_api_key,
    );
    crate::services::api_key_vars::unauthorized::native_usage::scope(
        credential_use,
        crate::services::balance::get_balance(&base_url, &resolved_api_key),
    )
    .await
}
