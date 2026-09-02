import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type {
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import { icons } from "../../../components/icons.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { ChatPageHost } from "../chat-state-host.ts";

type AccountInventory = {
  model: string;
  accounts: UserModelAccount[];
  nextCursor?: string;
  loading: boolean;
  error: string | null;
  isCurrent: () => boolean;
};

type AccountControlHost = Pick<ChatPageHost, "client" | "chatAccountSelection" | "requestUpdate">;
const inventories = new WeakMap<AccountControlHost, AccountInventory>();

export function renderChatModelAccountControl(params: {
  state: AccountControlHost;
  model: string;
  disabled: boolean;
  ownsSelection: () => boolean;
  onSelect: (authProfileId: string) => Promise<boolean>;
  onManage?: () => void;
}) {
  const { state } = params;
  const selection = state.chatAccountSelection;
  if (!selection) {
    return nothing;
  }
  let inventory = inventories.get(state);
  if (!inventory?.isCurrent() || inventory.model !== params.model) {
    inventory = {
      model: params.model,
      accounts: [],
      loading: false,
      error: null,
      isCurrent: () => params.ownsSelection() && state.chatAccountSelection === selection,
    };
    inventories.set(state, inventory);
  }
  const currentInventory = inventory;
  const ownsInventory = () =>
    inventories.get(state) === currentInventory && currentInventory.isCurrent();
  const loadAccounts = async (cursor?: string) => {
    const client = state.client;
    if (!client || !ownsInventory() || currentInventory.loading) {
      return;
    }
    currentInventory.loading = true;
    currentInventory.error = null;
    state.requestUpdate?.();
    try {
      const result = await client.request<UsersListModelAccountsResult>(
        "users.listModelAccounts",
        cursor ? { cursor } : {},
      );
      if (ownsInventory()) {
        currentInventory.accounts = cursor
          ? [...currentInventory.accounts, ...result.accounts]
          : result.accounts;
        currentInventory.nextCursor = result.nextCursor;
      }
    } catch (error) {
      if (ownsInventory()) {
        currentInventory.error = formatUiError(
          error,
          t("profilePage.modelAccounts.inventoryFailed"),
        );
      }
    } finally {
      if (ownsInventory()) {
        currentInventory.loading = false;
        state.requestUpdate?.();
      }
    }
  };
  const provider = params.model.includes("/")
    ? normalizeChatModelProviderId(params.model.slice(0, params.model.indexOf("/")))
    : "";
  const currentId = selection.kind === "automatic" ? undefined : selection.authProfileId;
  const description = (account: UserModelAccount | undefined) =>
    account &&
    currentInventory.accounts.some(
      (candidate) =>
        candidate.authProfileId !== account.authProfileId &&
        candidate.provider === account.provider &&
        candidate.label === account.label,
    )
      ? account.authProfileId
      : undefined;
  const currentValue = "current";
  const options: Array<{ value: string; label: string; description?: string; disabled?: boolean }> =
    [
      {
        value: currentValue,
        label: selection.label,
        description: description(
          currentInventory.accounts.find((account) => account.authProfileId === currentId),
        ),
      },
      ...currentInventory.accounts
        .filter((account) => account.provider === provider && account.authProfileId !== currentId)
        .map((account) => ({
          value: `account:${account.authProfileId}`,
          label: account.label,
          description: description(account),
        })),
      ...(currentInventory.loading
        ? [{ value: "loading", label: t("common.loading"), disabled: true }]
        : []),
      ...(currentInventory.nextCursor
        ? [{ value: "more", label: t("profilePage.modelAccounts.loadMore") }]
        : []),
      ...(params.onManage ? [{ value: "manage", label: t("chat.modelAccounts.manage") }] : []),
    ];
  const selectAccount = (value: string) => {
    if (!ownsInventory() || params.disabled) {
      return;
    }
    if (value === "manage") {
      params.onManage?.();
    } else if (value === "more") {
      void loadAccounts(currentInventory.nextCursor);
    } else {
      const account = currentInventory.accounts.find(
        (candidate) =>
          `account:${candidate.authProfileId}` === value && candidate.provider === provider,
      );
      if (account) {
        void params.onSelect(account.authProfileId);
      }
    }
  };
  return html`
    <div
      class="chat-model-account chat-controls__model-provenance"
      data-chat-account-selection=${selection.kind}
    >
      <span>${t("chat.modelAccounts.label")}</span>
      <wa-dropdown
        class="chat-model-account__picker"
        placement="top-start"
        aria-label=${t("chat.modelAccounts.label")}
        @wa-show=${() => void loadAccounts()}
        @wa-select=${(event: CustomEvent<{ item: { value: string } }>) =>
          selectAccount(event.detail.item.value)}
      >
        <button
          slot="trigger"
          type="button"
          class="chat-controls__inline-select-trigger"
          data-chat-account-trigger
          aria-label=${`${t("chat.modelAccounts.label")}: ${selection.label}`}
          ?disabled=${params.disabled}
        >
          <span class="chat-controls__inline-select-label">${selection.label}</span>
          <span class="chat-controls__inline-select-chevron" aria-hidden="true"
            >${icons.chevronDown}</span
          >
        </button>
        ${options.map(
          (option) => html`
            <wa-dropdown-item
              .value=${option.value}
              data-chat-account-option=${option.value}
              ?disabled=${option.disabled || params.disabled}
              ${ref((element) => {
                if (option.value === currentValue || option.value.startsWith("account:")) {
                  syncDropdownItemRadio(element, option.value === currentValue);
                }
              })}
            >
              <span
                >${option.label}${option.description
                  ? html`<br /><small>${option.description}</small>`
                  : nothing}</span
              >
            </wa-dropdown-item>
          `,
        )}
      </wa-dropdown>
      <span class="chat-model-account__hint">${t("chat.modelAccounts.hint")}</span>
      ${currentInventory.error
        ? html`<span class="chat-model-account__error" role="alert"
            >${currentInventory.error}</span
          >`
        : nothing}
    </div>
  `;
}
