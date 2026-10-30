import { setupActivityControls } from './activity-controls.js';
import { setupAdministrationControls } from './administration-controls.js';
import { setupApplicationControls } from './application-controls.js';
import { setupAuthoringControls } from './authoring-controls.js';
import { setupExploreControls } from './explore-controls.js';
import { setupLogisticsControls } from './logistics-controls.js';
import { setupResourceReader } from './resource-reader.js';

document.documentElement.dataset.clientBusy = 'true';
let selectedAccountId: string | undefined;
const reader = setupResourceReader({ selectedAccountId: () => selectedAccountId });
const authoringControls = setupAuthoringControls({ selectedAccountId: () => selectedAccountId, ...(reader === undefined ? {} : { reader }) });
const exploreControls = setupExploreControls({ selectedAccountId: () => selectedAccountId, ...(reader === undefined ? {} : { reader }) });
const logisticsControls = setupLogisticsControls({ selectedAccountId: () => selectedAccountId, ...(reader === undefined ? {} : { reader }) });
const administrationControls = setupAdministrationControls({ selectedAccountId: () => selectedAccountId });
setupApplicationControls({
  onAccountSelected: (account) => {
    selectedAccountId = account?.id;
    reader?.accountChanged();
    authoringControls?.accountChanged();
    exploreControls?.accountChanged();
    logisticsControls?.accountChanged();
    administrationControls?.accountChanged();
  }
});
setupActivityControls({ selectedAccountId: () => selectedAccountId });
document.documentElement.dataset.clientBusy = 'false';
