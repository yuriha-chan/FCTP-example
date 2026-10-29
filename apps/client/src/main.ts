import { setupActivityControls } from './activity-controls.js';
import { setupApplicationControls } from './application-controls.js';
import { setupExploreControls } from './explore-controls.js';
import { setupLogisticsControls } from './logistics-controls.js';

document.documentElement.dataset.clientBusy = 'true';
let selectedAccountId: string | undefined;
const exploreControls = setupExploreControls({ selectedAccountId: () => selectedAccountId });
const logisticsControls = setupLogisticsControls({ selectedAccountId: () => selectedAccountId });
setupApplicationControls({
  onAccountSelected: (account) => {
    selectedAccountId = account?.id;
    exploreControls?.accountChanged();
    logisticsControls?.accountChanged();
  }
});
setupActivityControls({ selectedAccountId: () => selectedAccountId });
document.documentElement.dataset.clientBusy = 'false';
