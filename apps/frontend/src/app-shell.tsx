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
import {
  loginAccount,
  logoutAccount,
  readAccounts,
  subscribeSessionChanges,
  type AccountListResponse
} from './application-api';
import { createShellState, type TopicId } from './shell-state';
import { useBoundState, type StateSubscription } from './use-bound-state';
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

function SignInForm({ onAuthenticated, submitLabel = 'Sign in' }: SignInFormProps): ReactElement {
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    let failure: string | undefined;
    try {
      const result = await loginAccount({ handle, password });
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
        setPassword('');
        setBusy(false);
        if (failure !== undefined) setError(failure);
      }
    }
  };

  return (
    <Form className={style('signInForm')} onSubmit={submit}>
      <TextField value={handle} onChange={setHandle} isRequired>
        <Label>Handle</Label>
        <Input autoComplete="username" />
      </TextField>
      <TextField value={password} onChange={setPassword} isRequired>
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
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [listLoading, setListLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const selectionRevisionRef = useRef(0);

  const accountId = useBoundState(
    () => shellState.read().accountId,
    useCallback<StateSubscription<string | undefined>>(
      (setValue) => shellState.subscribeAccountId((value) => setValue(value)),
      [shellState]
    )
  );

  const topic = useBoundState(
    () => shellState.read().topic,
    useCallback<StateSubscription<TopicId>>(
      (setValue) => shellState.subscribeTopic((value) => setValue(value)),
      [shellState]
    )
  );

  const setSelection = useCallback((nextAccountId: string | undefined): void => {
    selectionRevisionRef.current += 1;
    setAddOpen(false);
    setActionError(undefined);
    shellState.update({ accountId: nextAccountId });
  }, [shellState]);

  const applyAccounts = useCallback((next: readonly Account[], options: RefreshOptions, revisionAtStart: number): void => {
    setAccounts(next);
    if (revisionAtStart !== selectionRevisionRef.current) return;
    const current = shellState.read().accountId;
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
    if (current !== undefined) shellState.update({ accountId: undefined });
  }, [shellState, setSelection]);

  const refreshAccounts = useCallback(async (options: RefreshOptions = {}): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const revision = selectionRevisionRef.current;
    setListLoading(true);
    try {
      const response = await readAccounts();
      if (!mountedRef.current || generation !== generationRef.current) return;
      applyAccounts(response.accounts, options, revision);
      setListError(undefined);
    } catch (caught) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setListError(messageFor(caught));
    } finally {
      if (mountedRef.current && generation === generationRef.current) setListLoading(false);
    }
  }, [applyAccounts]);

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
    setActionError(undefined);
    void refreshAccounts({ preferredAccountId: nextAccountId });
  }, [refreshAccounts]);

  const handleAddAuthenticated = useCallback((nextAccountId: string): void => {
    setAddOpen(false);
    handleAuthenticated(nextAccountId);
  }, [handleAuthenticated]);

  const selectedAccount = accountId === undefined
    ? undefined
    : accounts.find((account) => account.id === accountId);

  const handleLogout = useCallback(async (): Promise<void> => {
    if (selectedAccount === undefined) return;
    const revision = selectionRevisionRef.current;
    setActionError(undefined);
    try {
      await logoutAccount(selectedAccount.id);
      if (!mountedRef.current) return;
      await refreshAccounts();
    } catch (caught) {
      if (mountedRef.current && revision === selectionRevisionRef.current) setActionError(messageFor(caught));
    }
  }, [selectedAccount, refreshAccounts]);

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
              <DialogTrigger isOpen={addOpen} onOpenChange={setAddOpen}>
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
            shellState.update({ topic: key as TopicId });
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
