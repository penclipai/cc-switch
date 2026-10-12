import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import UsageScriptModal from "@/components/UsageScriptModal";
import type { Provider } from "@/types";

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
  default: () => null,
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
        {children}
        {footer}
      </div>
    ) : null,
}));

const provider: Provider = {
  id: "codex-usage-test",
  name: "Usage test provider",
  settingsConfig: {},
  meta: {
    usage_script: {
      enabled: false,
      language: "javascript",
      code: "",
    },
  },
};

describe("UsageScriptModal", () => {
  it("waits for an async save before closing and ignores repeated saves", async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onSave = vi.fn(() => savePromise);
    const onClose = vi.fn();

    render(
      <UsageScriptModal
        provider={provider}
        appId="codex"
        isOpen
        onSave={onSave}
        onClose={onClose}
      />,
    );

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
    const onClose = vi.fn();

    render(
      <UsageScriptModal
        provider={provider}
        appId="codex"
        isOpen
        onSave={onSave}
        onClose={onClose}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "usageScript.saveConfig" }),
    );

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});
