import type { ReactElement } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import type { AuthorityRecord } from '@fctp/client-sdk';
import { RegistryCard } from './registry-card';
import { TerritoryCard } from './territory-card';
import { UiButton } from './ui';
import cssStyles from './authority-picker.module.css';

const styles = cssStyles as Record<
  'overlay' | 'modal' | 'dialog' | 'header' | 'heading' | 'meta' | 'error' | 'list' | 'candidate',
  string
>;

export type AuthorityPickerRole = 'territory' | 'registry';

export interface AuthorityPickerProps {
  role: AuthorityPickerRole;
  authorities: readonly AuthorityRecord[];
  selected: readonly string[];
  loading?: boolean;
  error?: string;
  onRetry: () => void;
  onSelect: (authority: AuthorityRecord) => void;
  onClose: () => void;
}

export function AuthorityPicker(props: AuthorityPickerProps): ReactElement {
  const title = props.role === 'registry' ? 'Add registry' : 'Add territory';
  const selected = new Set(props.selected);
  const candidates = props.authorities.filter((authority) => (
    authority.roles.includes(props.role) && !selected.has(authority.actorId)
  ));

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => { if (!open) props.onClose(); }}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog}>
          <header className={styles.header}>
            <Heading slot="title" level={2} className={styles.heading}>{title}</Heading>
            <UiButton onPress={props.onClose}>Cancel</UiButton>
          </header>
          <p className={styles.meta}>
            {`Choose a published ${props.role} from the retained discovery directory. Discovery does not grant admission permission.`}
          </p>
          {props.loading === true ? <p className={styles.meta}>Loading the retained discovery directory…</p> : null}
          {props.error === undefined ? null : (
            <>
              <p className={styles.error} role="alert">{props.error}</p>
              <UiButton onPress={props.onRetry}>Retry directory</UiButton>
            </>
          )}
          {props.loading !== true && props.error === undefined && candidates.length === 0 ? (
            <p className={styles.meta}>
              {`No unselected ${props.role === 'registry' ? 'registries' : 'territories'} are available in the retained discovery directory.`}
            </p>
          ) : null}
          {candidates.length === 0 ? null : (
            <ul className={styles.list}>
              {candidates.map((authority) => (
                <li key={authority.actorId} className={styles.candidate}>
                  {props.role === 'registry' ? (
                    <RegistryCard
                      {...(authority.name === undefined ? {} : { name: authority.name })}
                      {...(authority.handle === undefined ? {} : { handle: authority.handle })}
                      onPress={() => props.onSelect(authority)}
                    />
                  ) : (
                    <TerritoryCard
                      {...(authority.name === undefined ? {} : { name: authority.name })}
                      {...(authority.handle === undefined ? {} : { handle: authority.handle })}
                      onPress={() => props.onSelect(authority)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
