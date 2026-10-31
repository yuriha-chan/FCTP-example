import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Form,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField
} from 'react-aria-components';
import { treeState } from 'binduct';
import {
  loginAccount,
  logoutAccount,
  readAccounts,
  subscribeSessionChanges,
  type AccountListResponse
} from './application-api';
import { createShellState, type TopicId } from './shell-state';
import { useBoundFields } from './use-bound-state';
import styles from './shell.module.css';

export type { TopicId } from './shell-state';

export interface AccountContext {
  accountId?: string;
}

export interface AppShellProps {
  renderTopic?: (topic: TopicId, context: AccountContext) => ReactNode;
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
    label: 'Connections',
    description: 'Manage the servers and accounts this client is connected to.'
  },
  {
    id: 'explore',
    label: 'Explore',
    description: 'Discover places, routes, and available activities once an exploration workflow is connected.'
  },
  {
    id: 'logistics',
    label: 'Logistics & Production',
    description: 'Operate vessels and production workflows once they are connected.'
  },
  {
    id: 'authoring',
    label: 'Author & Publish',
    description: 'Author and publish content once an authoring workflow is connected.'
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Follow submitted actions and their outcomes once an activity workflow is connected.'
  },
  {
    id: 'administration',
    label: 'Administration',
    description: 'Review authority-scoped administration once an administration workflow is connected.'
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
  const { renderTopic } = props;
  const [shellState] = useState(createShellState);

  const {
    accountId,
    topic,
    accounts,
    listError,
    actionError,
    listLoading,
    addOpen
  } = useBoundFields(shellState);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const selectionRevisionRef = useRef(0);

  const setSelection = useCallback((nextAccountId: string | undefined): void => {
    selectionRevisionRef.current += 1;
    shellState.addOpen = false;
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
    shellState.actionError = undefined;
    void refreshAccounts({ preferredAccountId: nextAccountId });
  }, [refreshAccounts, shellState]);

  const handleAddAuthenticated = useCallback((nextAccountId: string): void => {
    shellState.addOpen = false;
    handleAuthenticated(nextAccountId);
  }, [handleAuthenticated, shellState]);

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

  const topicContext: AccountContext = accountId === undefined ? {} : { accountId };

  return (
    <section aria-label="Client" className={style('shell')}>
      <header className={style('header')}>
        <h1 className={style('title')}>Client</h1>
        {accounts.length === 0 ? null : (
          <div className={style('accounts')}>
            <ListBox
              aria-label="Accounts"
              className={style('accountList')}
              selectionMode="single"
              selectionBehavior="replace"
              disallowEmptySelection
              selectedKeys={accountId === undefined ? [] : [accountId]}
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const [key] = Array.from(keys);
                if (key !== undefined) setSelection(String(key));
              }}
            >
              {accounts.map((account) => (
                <ListBoxItem key={account.id} id={account.id} textValue={account.handle} className={style('accountOption')}>
                  {account.handle}
                </ListBoxItem>
              ))}
            </ListBox>
            <div className={style('accountActions')}>
              {selectedAccount === undefined ? null : (
                <Button className={style('secondary')} onPress={() => { void handleLogout(); }}>
                  Log out
                </Button>
              )}
              <DialogTrigger isOpen={addOpen} onOpenChange={(open) => { shellState.addOpen = open; }}>
                <Button className={style('secondary')}>Add account</Button>
                <ModalOverlay className={style('overlay')} isDismissable>
                  <Modal className={style('modal')}>
                    <Dialog aria-label="Add account" className={style('dialog')}>
                      {({ close }) => (
                        <div className={style('dialogContent')}>
                          <h2>Add account</h2>
                          <SignInForm onAuthenticated={handleAddAuthenticated} submitLabel="Sign in" />
                          <Button className={style('secondary')} onPress={close}>Cancel</Button>
                        </div>
                      )}
                    </Dialog>
                  </Modal>
                </ModalOverlay>
              </DialogTrigger>
            </div>
          </div>
        )}
      </header>
      {listError === undefined ? null : (
        <p role="status" className={style('error')}>Accounts could not be refreshed: {listError}</p>
      )}
      {actionError === undefined ? null : <p role="alert" className={style('error')}>{actionError}</p>}
      {listLoading && accounts.length === 0 ? <p role="status" className={style('muted')}>Loading accounts…</p> : null}
      {selectedAccount === undefined ? (
        <div className={style('signIn')}>
          <h2>Sign in</h2>
          <p className={style('muted')}>Use the account handle and password for this client session.</p>
          <SignInForm onAuthenticated={handleAuthenticated} />
        </div>
      ) : null}
      <Tabs
        className={style('tabs')}
        selectedKey={topic}
        onSelectionChange={(key) => {
          if (typeof key === 'string' && TOPIC_IDS.has(key)) {
            shellState.topic = key as TopicId;
          }
        }}
      >
        <TabList aria-label="Topics" className={style('tabList')}>
          {TOPICS.map((entry) => (
            <Tab key={entry.id} id={entry.id} className={style('tab')}>{entry.label}</Tab>
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
