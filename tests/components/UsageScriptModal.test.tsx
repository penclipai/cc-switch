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
