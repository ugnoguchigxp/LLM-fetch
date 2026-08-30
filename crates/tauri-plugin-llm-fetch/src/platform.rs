use crate::contracts::{PlatformSupport, SupportLevel};

pub fn platform_support() -> PlatformSupport {
    #[cfg(target_os = "macos")]
    {
        let version = sysinfo::System::os_version();
        let supported = version
            .as_deref()
            .and_then(|v| v.split('.').next())
            .and_then(|v| v.parse::<u32>().ok())
            .is_some_and(|v| v >= 14);
        if supported {
            return PlatformSupport {
                overall: SupportLevel::Supported,
                proxy_enforcement: SupportLevel::Supported,
                background_execution: SupportLevel::Supported,
                incognito_storage: SupportLevel::Supported,
                reasons: vec![],
            };
        }
        PlatformSupport {
            overall: SupportLevel::Unsupported,
            proxy_enforcement: SupportLevel::Unsupported,
            background_execution: SupportLevel::Unsupported,
            incognito_storage: SupportLevel::BestEffort,
            reasons: vec!["macOS 14 or newer is required.".into()],
        }
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        PlatformSupport {
            overall: SupportLevel::BestEffort,
            proxy_enforcement: SupportLevel::BestEffort,
            background_execution: SupportLevel::BestEffort,
            incognito_storage: SupportLevel::BestEffort,
            reasons: vec![
                "This platform is preview-only because hidden WebView execution is not reliable."
                    .into(),
            ],
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        PlatformSupport {
            overall: SupportLevel::Unsupported,
            proxy_enforcement: SupportLevel::Unsupported,
            background_execution: SupportLevel::Unsupported,
            incognito_storage: SupportLevel::Unsupported,
            reasons: vec!["This platform is not supported.".into()],
        }
    }
}
