import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import UsageScriptModal from "@/components/UsageScriptModal";
import type { Provider, UsageScript } from "@/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: undefined }),
}));

vi.mock("@/hooks/useDarkMode", () => ({
  useDarkMode: () => false,
}));

vi.mock("@/components/JsonEditor", () => ({
  default: ({ value }: { value: string }) => (
    <textarea data-testid="usage-script-code" value={value} readOnly />
  ),
}));

vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    isOpen,
    children,
    footer,
    onClose,
  }: {
    isOpen: boolean;
    children: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
  }) =>
    isOpen ? (
      <div>
        <button onClick={onClose}>panel-close</button>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

const provider: Provider = {
  id: "sub2api-site",
  name: "Example Sub2API",
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: "https://api.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-test",
    },
  },
  meta: {
    usage_script: {
      enabled: true,
      language: "javascript",
      code: "({ request: { url: '' }, extractor: function () { return {}; } })",
    },
  },
};

function renderModal(
  onSave: (script: UsageScript) => void | Promise<void>,
  usageScript?: UsageScript,
  onClose = vi.fn(),
) {
  render(
    <UsageScriptModal
      provider={
        usageScript
          ? { ...provider, meta: { usage_script: usageScript } }
          : provider
      }
      appId="claude"
      isOpen
      onClose={onClose}
      onSave={onSave}
    />,
  );

  return onClose;
}

describe("UsageScriptModal", () => {
  it("waits for an async save before closing and ignores repeated saves", async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onSave = vi.fn(() => savePromise);
    const onClose = renderModal(onSave);

    const saveButton = screen.getByRole("button", {
      name: "usageScript.saveConfig",
    });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "common.cancel" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "panel-close" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave();
      await savePromise;
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open when the save owner rejects after showing its error", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("save failed"));
    const onClose = renderModal(onSave);

    fireEvent.click(
      screen.getByRole("button", { name: "usageScript.saveConfig" }),
    );

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fills the /v1/usage script and saves it as the sub2api template", async () => {
    const onSave = vi.fn();
    renderModal(onSave);

    await userEvent.click(
      screen.getByRole("button", { name: "usageScript.templateSub2API" }),
    );

    const code = (
      screen.getByTestId("usage-script-code") as HTMLTextAreaElement
    ).value;
    expect(code).toContain('+ "/v1/usage"');
    expect(code).toContain("Bearer {{apiKey}}");
    expect(screen.getByLabelText(/API Key/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("usageScript.accessToken"),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "usageScript.saveConfig" }),
    );
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ templateType: "sub2api", code }),
    );
  });

  it("reopens a script saved with the sub2api template as that template", async () => {
    const onSave = vi.fn();
    renderModal(onSave, {
      ...provider.meta!.usage_script!,
      templateType: "sub2api",
    });

    await userEvent.click(
      screen.getByRole("button", { name: "usageScript.saveConfig" }),
    );
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ templateType: "sub2api" }),
    );
  });
});

describe("UsageScriptModal official subscription hint", () => {
  // agy 的额度靠它自己的 /usage 命令查，不读登录凭据
  it("explains Antigravity's quota check instead of reading OAuth credentials", () => {
    render(
      <UsageScriptModal
        provider={{
          id: "agy-official",
          name: "Google Official",
          category: "official",
          settingsConfig: { env: {}, config: {} },
          meta: {
            usage_script: {
              enabled: true,
              language: "javascript",
              code: "",
              templateType: "official_subscription",
            },
          },
        }}
        appId="agy"
        isOpen
        onClose={() => {}}
        onSave={vi.fn()}
      />,
    );
    expect(
      screen.getByText("usageScript.officialSubscriptionHintAgy"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("usageScript.officialSubscriptionHint"),
    ).not.toBeInTheDocument();
  });
});

describe("UsageScriptModal Claude official card bound to an account", () => {
  // 卡片和托盘在没保存开关时默认查这个号的额度，配置页也要显示为已开
  it("shows usage enabled by default when nothing was saved", async () => {
    const onSave = vi.fn();
    render(
      <UsageScriptModal
        provider={{
          id: "claude-bound",
          name: "Claude Official",
          category: "official",
          settingsConfig: { env: {} },
          meta: {
            authBinding: {
              source: "managed_account",
              authProvider: "claude_official",
              accountId: "acct-1",
            },
          },
        }}
        appId="claude"
        isOpen
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "usageScript.saveConfig" }),
    );
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        templateType: "official_subscription",
      }),
    );
  });
});

/**
 * Oh My Pi has its own `AppId` ("omp"), so it never matched the `pi` branch
 * and both built-in tests reported "API key is empty" on an omp card. The
 * provider key and base URL must reach the balance API like they do for Pi.
 */
describe("UsageScriptModal Oh My Pi credentials", () => {
  it("passes the omp provider's key and base URL to the balance test", async () => {
    const getBalance = vi.fn().mockResolvedValue({ success: true, data: [] });
    vi.doMock("@/lib/api/subscription", () => ({
      subscriptionApi: { getBalance },
    }));
    const { default: Modal } = await import("@/components/UsageScriptModal");
    render(
      <Modal
        provider={{
          id: "cc-switch-demo",
          name: "Demo",
          // A base URL the balance template recognises, so the test reaches
          // `getBalance` instead of stopping at the template picker.
          settingsConfig: {
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "sk-omp",
            api: "openai-completions",
          },
        }}
        appId="omp"
        isOpen
        onClose={() => {}}
        onSave={() => {}}
      />,
    );

    // The usage query is off by default; enabling it asks for confirmation once.
    await userEvent.click(screen.getByRole("switch"));
    await userEvent.click(
      screen.getByRole("button", { name: "confirm.usage.confirm" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "usageScript.testScript" }),
    );

    expect(getBalance).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1",
      "sk-omp",
    );
  });
});

describe("UsageScriptModal DeepSeek Harness credentials", () => {
  const dshProvider: Provider = {
    id: "deepseek-dsh",
    name: "DeepSeek",
    settingsConfig: {
      api: "openai-completions",
      options: {
        baseURL: "https://api.deepseek.com/v1/",
        apiKey: "sk-test-dsh",
      },
      models: {},
    },
    meta: {
      usage_script: {
        enabled: true,
        language: "javascript",
        code: "",
      },
    },
  };

  function renderDshModal() {
    render(
      <UsageScriptModal
        provider={dshProvider}
        appId="dsh"
        isOpen
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
  }

  it("detects the official balance template from the DSH provider endpoint", () => {
    renderDshModal();

    expect(screen.getByText("usageScript.balanceHint")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-script-code")).not.toBeInTheDocument();
  });

  it("passes the saved DSH key and normalized endpoint to the balance test", async () => {
    const { subscriptionApi } = await import("@/lib/api/subscription");
    const getBalance = vi
      .spyOn(subscriptionApi, "getBalance")
      .mockResolvedValue({
        success: true,
        data: [{ isValid: true, remaining: 1, unit: "CNY" }],
      });

    try {
      renderDshModal();
      await userEvent.click(
        screen.getByRole("button", { name: "usageScript.templateBalance" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "usageScript.testScript" }),
      );

      expect(getBalance).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1",
        "sk-test-dsh",
      );
    } finally {
      getBalance.mockRestore();
    }
  });

  it("shows inherited DSH credentials in the custom template variables", async () => {
    renderDshModal();
    await userEvent.click(
      screen.getByRole("button", { name: "usageScript.templateCustom" }),
    );

    expect(screen.getByText("https://api.deepseek.com/v1")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "apiKeyInput.show" }),
    );
    expect(screen.getByText("sk-test-dsh")).toBeInTheDocument();
  });
});

describe.each([
  {
    appId: "mcode" as const,
    settingsConfig: {
      kind: "custom",
      api: "openai-completions",
      options: {
        baseURL: "https://api.deepseek.com/v1/",
        apiKey: "sk-test-mcode",
      },
      models: {},
    },
    apiKey: "sk-test-mcode",
  },
  {
    appId: "kimi" as const,
    settingsConfig: {
      provider: {
        type: "openai",
        base_url: "https://api.deepseek.com/v1/",
        api_key: "sk-test-kimi",
      },
    },
    apiKey: "sk-test-kimi",
  },
])(
  "UsageScriptModal $appId credentials",
  ({ appId, settingsConfig, apiKey }) => {
    function renderAppModal() {
      render(
        <UsageScriptModal
          provider={{
            id: `deepseek-${appId}`,
            name: "DeepSeek",
            settingsConfig,
            meta: {
              usage_script: {
                enabled: true,
                language: "javascript",
                code: "",
              },
            },
          }}
          appId={appId}
          isOpen
          onClose={() => {}}
          onSave={() => {}}
        />,
      );
    }

    it("passes the saved key and normalized endpoint to the balance test", async () => {
      const { subscriptionApi } = await import("@/lib/api/subscription");
      const getBalance = vi
        .spyOn(subscriptionApi, "getBalance")
        .mockResolvedValue({
          success: true,
          data: [{ isValid: true, remaining: 1, unit: "CNY" }],
        });

      try {
        renderAppModal();
        // The DeepSeek endpoint auto-selects the official balance template.
        expect(screen.getByText("usageScript.balanceHint")).toBeInTheDocument();
        await userEvent.click(
          screen.getByRole("button", { name: "usageScript.testScript" }),
        );

        expect(getBalance).toHaveBeenCalledWith(
          "https://api.deepseek.com/v1",
          apiKey,
        );
      } finally {
        getBalance.mockRestore();
      }
    });

    it("shows inherited credentials in the custom template variables", async () => {
      renderAppModal();
      await userEvent.click(
        screen.getByRole("button", { name: "usageScript.templateCustom" }),
      );

      expect(
        screen.getByText("https://api.deepseek.com/v1"),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "apiKeyInput.show" }),
      );
      expect(screen.getByText(apiKey)).toBeInTheDocument();
    });
  },
);
