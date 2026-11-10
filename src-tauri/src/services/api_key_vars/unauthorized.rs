//! A request can reject only the variable generation that supplied its credential.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Weak};

use super::{resolve, wake_scheduler};

const READY: u8 = 0;
const PENDING: u8 = 1;
const REFRESHING: u8 = 2;

#[derive(Default, Clone, Debug)]
pub(super) struct Generation(Arc<AtomicU8>);

impl Generation {
    pub(super) fn credential(&self) -> Option<CredentialUse> {
        (!self.refreshing()).then(|| CredentialUse(Arc::downgrade(&self.0)))
    }

    pub(super) fn pending(&self) -> bool {
        self.0.load(Ordering::Acquire) == PENDING
    }

    pub(super) fn refreshing(&self) -> bool {
        self.0.load(Ordering::Acquire) == REFRESHING
    }

    pub(super) fn start(&mut self) -> ActiveRefresh {
        // Requests already in flight retain only weak references to the old generation.
        self.0 = Arc::new(AtomicU8::new(REFRESHING));
        ActiveRefresh(self.0.clone())
    }
}

pub(super) struct ActiveRefresh(Arc<AtomicU8>);

impl Drop for ActiveRefresh {
    fn drop(&mut self) {
        self.0.store(READY, Ordering::Release);
    }
}

/// A weak reference deliberately retains neither the secret nor a retired generation.
#[derive(Clone, Debug)]
pub(crate) struct CredentialUse(Weak<AtomicU8>);

impl CredentialUse {
    pub(crate) fn capture(raw_key: &str, sent_key: &str) -> Option<Self> {
        let name = resolve::parse_ref(raw_key)?;
        resolve::credential_use(name, sent_key)
    }

    pub(crate) fn signal(&self) {
        if let Some(generation) = self.0.upgrade() {
            if generation
                .compare_exchange(READY, PENDING, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                wake_scheduler();
            }
        }
    }

    pub(crate) fn observe_json(&self, body: &[u8]) {
        if json_code_401(body) {
            self.signal();
        }
    }
}

pub(crate) fn json_value_code_401(body: &serde_json::Value) -> bool {
    body.get("code").is_some_and(is_401)
}

fn is_401(code: &serde_json::Value) -> bool {
    code.as_i64() == Some(401) || code.as_str() == Some("401")
}

pub(crate) fn json_code_401(body: &[u8]) -> bool {
    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(default)]
        code: serde_json::Value,
    }
    // Skip unrelated fields without allocating another copy of model responses.
    body.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{')
        && serde_json::from_slice::<Envelope>(body).is_ok_and(|json| is_401(&json.code))
}

/// Request-scoped observer for native usage APIs. It retains only a weak
/// generation reference, and its scope is installed only after the caller has
/// established that this exact request sends the dynamic variable's value.
pub(crate) mod native_usage {
    use std::future::Future;

    use super::{json_code_401, json_value_code_401, CredentialUse};

    tokio::task_local! {
        static CREDENTIAL: Option<CredentialUse>;
    }

    pub(crate) async fn scope<T>(
        credential: Option<CredentialUse>,
        operation: impl Future<Output = T>,
    ) -> T {
        CREDENTIAL.scope(credential, operation).await
    }

    pub(crate) fn status(status: reqwest::StatusCode) {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            signal();
        }
    }

    pub(crate) fn json(body: &serde_json::Value) {
        if json_value_code_401(body) {
            signal();
        }
    }

    pub(crate) fn bytes(body: &[u8]) {
        if is_active() && json_code_401(body) {
            signal();
        }
    }

    pub(crate) fn is_active() -> bool {
        CREDENTIAL.try_with(Option::is_some).unwrap_or(false)
    }

    /// Observe a terminal 401/403 response. A 401 is enough to signal before
    /// reading the body. A dynamic-key 403 gets its already-terminal body
    /// inspected for the gateway's `{code: 401}` envelope.
    pub(crate) async fn auth_error(mut response: reqwest::Response) {
        let response_status = response.status();
        status(response_status);
        if response_status == reqwest::StatusCode::FORBIDDEN && is_active() {
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk))
                        if body.len().saturating_add(chunk.len())
                            <= crate::proxy::hyper_client::MAX_RESPONSE_BODY_BYTES =>
                    {
                        body.extend_from_slice(&chunk)
                    }
                    Ok(None) => {
                        bytes(&body);
                        return;
                    }
                    _ => return,
                }
            }
        }
    }

    fn signal() {
        let _ = CREDENTIAL.try_with(|credential| {
            if let Some(credential) = credential {
                credential.signal();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::database::Database;
    use crate::services::api_key_vars::{
        due_vars, refresh_due_var, runner::now_ms, ApiKeyRefreshConfig, ApiKeyRefreshState,
        RefreshReason,
    };
    use crate::store::AppState;

    #[test]
    fn only_a_complete_top_level_error_object_counts() {
        assert!(json_code_401(br#" {"code":401,"message":"expired"} "#));
        assert!(json_code_401(br#"{"code":"401"}"#));
        for body in [
            "[401]",
            r#"{"error":{"code":401}}"#,
            r#"{"code":403}"#,
            r#"{"code":401}x"#,
        ] {
            assert!(!json_code_401(body.as_bytes()), "{body}");
        }
    }

    #[tokio::test]
    async fn concurrent_rejections_run_one_script_and_drop_late_responses() {
        const NAME: &str = "REJECTION_E2E";
        const TEMPLATE: &str = "{{REJECTION_E2E}}";
        let script = tempfile::tempdir().unwrap();
        std::fs::write(
            script.path().join("index.mjs"),
            r#"import {appendFileSync} from 'node:fs';
appendFileSync('calls', process.env.CC_SWITCH_REASON + '\n');
console.log(JSON.stringify({apiKey: 'rotated-test-key'}));"#,
        )
        .unwrap();
        let db = Arc::new(Database::memory().unwrap());
        let state = AppState::new(db.clone());
        db.upsert_api_key_var(
            None,
            NAME,
            &ApiKeyRefreshConfig {
                enabled: true,
                script_dir: script.path().to_str().unwrap().into(),
                ..Default::default()
            },
        )
        .unwrap();
        db.update_api_key_var_result(
            NAME,
            Some("old-test-key"),
            &ApiKeyRefreshState {
                last_success_at: Some(now_ms()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(due_vars(&db, now_ms()).is_empty());
        assert!(CredentialUse::capture("old-test-key", "old-test-key").is_none());
        assert!(CredentialUse::capture(TEMPLATE, "another-key").is_none());
        let request = CredentialUse::capture(TEMPLATE, "old-test-key").unwrap();
        std::thread::scope(|scope| {
            for _ in 0..16 {
                scope.spawn(|| request.signal());
            }
        });
        assert_eq!(
            due_vars(&db, now_ms()),
            vec![(NAME.into(), RefreshReason::Unauthorized)]
        );
        let notifications = AtomicUsize::new(0);
        let dispatch = || {
            refresh_due_var(&state, NAME, RefreshReason::Unauthorized, |outcome, _| {
                assert!(outcome.success, "{:?}", outcome.error);
                notifications.fetch_add(1, Ordering::Relaxed);
                // The new value has been committed. Further rejections while the
                // worker is still notifying listeners belong to the current refresh.
                request.signal();
                assert!(CredentialUse::capture(TEMPLATE, "rotated-test-key").is_none());
            })
        };
        let (first, duplicate) = tokio::join!(dispatch(), dispatch());
        first.unwrap();
        duplicate.unwrap();
        assert_eq!(notifications.load(Ordering::Relaxed), 1);
        assert_eq!(
            std::fs::read_to_string(script.path().join("calls")).unwrap(),
            "unauthorized\n"
        );
        request.signal();
        assert!(due_vars(&db, now_ms()).is_empty());
        let new_request = CredentialUse::capture(TEMPLATE, "rotated-test-key").unwrap();
        new_request.signal();
        assert_eq!(
            due_vars(&db, now_ms()),
            vec![(NAME.into(), RefreshReason::Unauthorized)]
        );
    }

    #[test]
    fn failed_refresh_rearms_only_new_requests_for_the_same_value() {
        const NAME: &str = "REJECTION_UNCHANGED";
        const TEMPLATE: &str = "{{REJECTION_UNCHANGED}}";
        resolve::cache_set(NAME, true, Some("same"));
        let old = CredentialUse::capture(TEMPLATE, "same").unwrap();
        old.signal();
        let running = resolve::begin_refresh(NAME, true).unwrap();
        old.signal();
        assert!(CredentialUse::capture(TEMPLATE, "same").is_none());
        assert!(!resolve::rejection_pending(NAME));
        drop(running);
        old.signal();
        assert!(!resolve::rejection_pending(NAME));
        CredentialUse::capture(TEMPLATE, "same").unwrap().signal();
        assert!(resolve::rejection_pending(NAME));
        resolve::cache_set(NAME, false, Some("same"));
        assert!(!resolve::rejection_pending(NAME));
        assert!(CredentialUse::capture(TEMPLATE, "same").is_none());
    }
}
