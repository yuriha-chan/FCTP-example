import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  Form,
  Input,
  Label,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField
} from 'react-aria-components';
import { treeState } from 'binduct';
import type { PublicAccountRecord } from '@fctp/client-sdk';
import {
  loginAccount,
  logoutAccount,
  readAccounts,
  subscribeSessionChanges,
  type AccountListResponse
} from './application-api';
import { canonicalizeRoute, navigateToTopic, useRoute, type AppRoute, type TopicId } from './router';
import { createShellState } from './shell-state';
import { useBoundFields } from './use-bound-state';
import { EmptyState } from './ui';
import styles from './shell.module.css';

export type { TopicId } from './router';

export interface AccountContext {
  accountId?: string;
  accountHandle?: string;
  account?: PublicAccountRecord;
}

export interface TopicContext extends AccountContext {
  navigateTopic: (topic: TopicId) => void;
  route: AppRoute;
}

export interface AppShellProps {
  renderTopic?: (topic: TopicId, context: TopicContext) => ReactNode;
  onAccountChange?: (accountId: string | undefined) => void;
}

type Account = AccountListResponse['accounts'][number];

interface TopicDefinition {
  readonly id: TopicId;
  readonly label: string;
  readonly description: string;
}

const TOPICS: readonly TopicDefinition[] = [
  {
    id: 'connections',
    label: 'Worlds & accounts',
    description: 'See which worlds and servers this client can reach, and which accounts you are signed in with.'
  },
  {
    id: 'explore',
    label: 'Explore',
    description: 'Browse places, ports and routes, and plan where your vessels go next.'
  },
  {
    id: 'logistics',
    label: 'Voyages & production',
    description: 'Move vessels between ports and run production jobs for your cargo.'
  },
  {
    id: 'authoring',
    label: 'Create',
    description: 'Design new items and varieties, then publish them for others to produce and trade.'
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Follow the actions you have submitted and see how each one turned out.'
  },
  {
    id: 'administration',
    label: 'Administration',
    description: 'Review and adjust the settings of the territories and authorities you manage.'
  }
];

const TOPIC_IDS = new Set<string>(TOPICS.map((topic) => topic.id));

function style(name: string): string {
  return styles[name] ?? '';
}

interface RefreshOptions {
  preferredAccountId?: string;
  allowFirst?: boolean;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SignInFormProps {
  onAuthenticated: (accountId: string) => void;
  submitLabel?: string;
}

interface SignInState {
  handle: string;
  password: string;
  error: string | undefined;
  busy: boolean;
}

function SignInForm({ onAuthenticated, submitLabel = 'Sign in' }: SignInFormProps): ReactElement {
  const [signInState] = useState(() => treeState<SignInState>({
    handle: '',
    password: '',
    error: undefined,
    busy: false
  }));
  const mounted = useRef(false);

  const { handle, password, error, busy } = useBoundFields(signInState);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (signInState.busy) return;
    signInState.busy = true;
    signInState.error = undefined;
    let failure: string | undefined;
    try {
      const result = await loginAccount({ handle: signInState.handle, password: signInState.password });
      if (!mounted.current) return;
      if (result.status === 'signed-in' && result.account) {
        onAuthenticated(result.account.id);
      } else {
        failure = result.reason ?? `Sign in was not accepted (${result.status})`;
      }
    } catch (caught) {
      failure = messageFor(caught);
    } finally {
      if (mounted.current) {
        signInState.password = '';
        signInState.busy = false;
        if (failure !== undefined) signInState.error = failure;
      }
    }
  };

  return (
    <Form className={style('signInForm')} onSubmit={submit}>
      <TextField value={handle} onChange={(next) => { signInState.handle = next; }} isRequired>
        <Label>Handle</Label>
        <Input autoComplete="username" />
      </TextField>
      <TextField value={password} onChange={(next) => { signInState.password = next; }} isRequired>
        <Label>Password</Label>
        <Input type="password" autoComplete="current-password" />
      </TextField>
      {error === undefined ? null : <p role="alert" className={style('error')}>{error}</p>}
      <Button type="submit" className={style('primary')} isPending={busy}>
        {submitLabel}
      </Button>
    </Form>
  );
}

function DefaultTopic({ topic }: { topic: TopicDefinition }): ReactElement {
  return (
    <div className={style('topicContent')}>
      <h2>{topic.label}</h2>
      <p>{topic.description}</p>
    </div>
  );
}

export function AppShell(props: AppShellProps): ReactElement {
  const { renderTopic, onAccountChange } = props;
  const [shellState] = useState(createShellState);

  const {
    accountId,
    accounts,
    listError,
    actionError,
    listLoading,
    signInOpen
  } = useBoundFields(shellState);
  const route = useRoute();
  const topic = route.topic;

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const topicTabs = useRef<Partial<Record<TopicId, HTMLElement | null>>>({});

  useEffect(() => { onAccountChange?.(accountId); }, [accountId, onAccountChange]);

  useEffect(() => { canonicalizeRoute(); }, []);

  const navigateTopic = useCallback((next: TopicId): void => {
    navigateToTopic(next);
    topicTabs.current[next]?.focus();
  }, []);

  const setSelection = useCallback((nextAccountId: string | undefined): void => {
    selectionRevisionRef.current += 1;
    shellState.signInOpen = false;
    shellState.actionError = undefined;
    shellState.accountId = nextAccountId;
  }, [shellState]);

  const applyAccounts = useCallback((next: readonly Account[], options: RefreshOptions, revisionAtStart: number): void => {
    shellState.accounts = treeState([...next]);
    if (revisionAtStart !== selectionRevisionRef.current) return;
    const current = shellState.accountId;
    const contains = (candidate: string | undefined): boolean =>
      candidate !== undefined && next.some((account) => account.id === candidate);
    if (contains(options.preferredAccountId)) {
      if (current !== options.preferredAccountId) setSelection(options.preferredAccountId);
      return;
    }
    if (contains(current)) return;
    if (options.allowFirst && next.length > 0) {
      setSelection(next[0]!.id);
      return;
    }
    if (current !== undefined) shellState.accountId = undefined;
  }, [shellState, setSelection]);

  const refreshAccounts = useCallback(async (options: RefreshOptions = {}): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const revision = selectionRevisionRef.current;
    shellState.listLoading = true;
    try {
      const response = await readAccounts();
      if (!mountedRef.current || generation !== generationRef.current) return;
      applyAccounts(response.accounts, options, revision);
      shellState.listError = undefined;
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      shellState.listError = messageFor(caught);
    } finally {
      if (mountedRef.current && generation === generationRef.current) shellState.listLoading = false;
    }
  }, [applyAccounts, shellState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void refreshAccounts({ allowFirst: true });
  }, [refreshAccounts]);

  useEffect(() => subscribeSessionChanges(() => {
    void refreshAccounts();
  }), [refreshAccounts]);

  const handleAuthenticated = useCallback((nextAccountId: string): void => {
    shellState.signInOpen = false;
    shellState.actionError = undefined;
    void refreshAccounts({ preferredAccountId: nextAccountId });
  }, [refreshAccounts, shellState]);

  const selectedAccount = accountId === undefined
    ? undefined
    : accounts.find((account) => account.id === accountId);

  const handleLogout = useCallback(async (): Promise<void> => {
    if (selectedAccount === undefined) return;
    const revision = selectionRevisionRef.current;
    shellState.actionError = undefined;
    try {
      await logoutAccount(selectedAccount.id);
      if (!mountedRef.current) return;
      await refreshAccounts();
    } catch (caught) {
      if (mountedRef.current && revision === selectionRevisionRef.current) shellState.actionError = messageFor(caught);
    }
  }, [selectedAccount, refreshAccounts, shellState]);

  const topicContext: TopicContext = {
    navigateTopic,
    route,
    ...(accountId === undefined ? {} : { accountId }),
    ...(selectedAccount === undefined ? {} : { accountHandle: selectedAccount.handle, account: selectedAccount })
  };
  const signInTitle = accounts.length === 0 ? 'Sign in' : 'Add account';

  return (
    <section aria-label="Client" className={style('shell')}>
      <header className={style('header')}>
        <div className={style('brand')}>
          <h1 className={style('title')}>Common Realms</h1>
          <span className={style('subtitle')}>Client</span>
        </div>
        <div className={style('accounts')}>
          {accounts.length === 0 ? null : (
            <MenuTrigger>
              <Button className={style('accountMenuTrigger')} aria-label="Account menu">
                <span className={style('accountMenuLabel')}>{selectedAccount?.handle ?? 'Accounts'}</span>
                <span aria-hidden="true" className={style('accountMenuChevron')}>▾</span>
              </Button>
              <Popover className={style('accountPopover')} placement="bottom end">
                <Menu
                  aria-label="Accounts"
                  className={style('accountMenu')}
                  onAction={(key) => { setSelection(String(key)); }}
                >
                  {accounts.map((account) => (
                    <MenuItem
                      key={account.id}
                      id={account.id}
                      textValue={account.handle}
                      aria-label={account.id === accountId ? `${account.handle}, current account` : account.handle}
                      className={style('accountMenuItem')}
                    >
                      <span className={style('accountMenuHandle')}>{account.handle}</span>
                      {account.id === accountId ? <span aria-hidden="true" className={style('accountMenuCurrent')}>✓</span> : null}
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
          )}
          <div className={style('accountActions')}>
            <Button className={style('secondary')} onPress={() => { shellState.signInOpen = true; }}>
              {accounts.length === 0 ? 'Sign in' : 'Add account'}
            </Button>
            {selectedAccount === undefined ? null : (
              <Button className={style('secondary')} onPress={() => { void handleLogout(); }}>
                Log out
              </Button>
            )}
          </div>
        </div>
      </header>
      <ModalOverlay
        className={style('overlay')}
        isOpen={signInOpen}
        onOpenChange={(open) => { shellState.signInOpen = open; }}
        isDismissable
      >
        <Modal className={style('modal')}>
          <Dialog aria-label={signInTitle} className={style('dialog')}>
            {({ close }) => (
              <div className={style('dialogContent')}>
                <h2>{signInTitle}</h2>
                <p className={style('muted')}>
                  {accounts.length === 0
                    ? 'Use the account handle and password for this client session.'
                    : 'Sign in with another account handle and password.'}
                </p>
                <SignInForm onAuthenticated={handleAuthenticated} submitLabel="Sign in" />
                <Button className={style('secondary')} onPress={close}>Cancel</Button>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      {listError === undefined && actionError === undefined && !(listLoading && accounts.length === 0) ? null : (
        <div className={style('notices')}>
          {listError === undefined ? null : (
            <p role="status" className={style('error')}>Accounts could not be refreshed: {listError}</p>
          )}
          {actionError === undefined ? null : <p role="alert" className={style('error')}>{actionError}</p>}
          {listLoading && accounts.length === 0 ? <p role="status" className={style('muted')}>Loading accounts…</p> : null}
        </div>
      )}
      {!listLoading && listError === undefined && accounts.length === 0 ? (
        <div className={style('welcome')}>
          <EmptyState
            title="Welcome to Common Realms"
            actions={(
              <Button className={style('primary')} onPress={() => { shellState.signInOpen = true; }}>
                Sign in
              </Button>
            )}
          >
            Sign in with your Home account to explore worlds, move cargo and publish your own items.
            You can browse the tabs below first; most actions need an account.
          </EmptyState>
        </div>
      ) : null}
      <Tabs
        className={style('tabs')}
        selectedKey={topic}
        onSelectionChange={(key) => {
          if (typeof key === 'string' && TOPIC_IDS.has(key)) navigateTopic(key as TopicId);
        }}
      >
        <TabList aria-label="Topics" className={style('tabList')}>
          {TOPICS.map((entry) => (
            <Tab key={entry.id} id={entry.id} ref={(element) => { topicTabs.current[entry.id] = element; }} className={style('tab')}>{entry.label}</Tab>
          ))}
        </TabList>
        {TOPICS.map((entry) => (
          <TabPanel key={entry.id} id={entry.id} shouldForceMount className={style('panel')}>
            <div key={accountId ?? '__no-account__'} className={style('panelContent')}>
              {renderTopic?.(entry.id, topicContext) ?? <DefaultTopic topic={entry} />}
            </div>
          </TabPanel>
        ))}
      </Tabs>
    </section>
  );
}
