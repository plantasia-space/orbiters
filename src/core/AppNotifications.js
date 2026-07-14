import { getT } from '../i18n/index.js';
import { getToastSink, isToastKindSuppressed, suppressToastKind } from '../ui/react/toastBridge';

function getUiCoreNamespace() {
    if (typeof globalThis !== 'undefined' && globalThis.uiCore) {
        return globalThis.uiCore;
    }
    if (typeof window !== 'undefined' && window.uiCore) {
        return window.uiCore;
    }
    return null;
}

/**
 * @file AppNotifications.js
 * @description Manages application notifications, including toast messages and modals.
 * @version 2.0.0
 */

export class AppNotifications {
    /**
     * Creates an instance of AppNotifications.
     * Container resolution is deferred to first use: this module constructs a singleton at import
     * time, and a package consumer may evaluate the graph before the document (or `<body>`) exists.
     */
    constructor() {
        this.notificationContainer = null;
    }

    /**
     * Resolves — and on first toast creates — the notification container. Lazy so importing this
     * module has no DOM side effect. Returns null when no usable document exists yet.
     * @returns {HTMLElement|null}
     */
    getContainer() {
        if (this.notificationContainer?.isConnected) return this.notificationContainer;
        if (typeof document === 'undefined' || !document.body) return null;

        let container = document.getElementById('notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'notification-container';
            document.body.appendChild(container);
        }
        this.notificationContainer = container;
        return container;
    }

    /**
     * Removes any orphaned loader fragments that should never persist in the
     * notifications layer after app startup completes. Sweep-only: never creates the container.
     */
    clearTransientLoaders() {
        const container =
            this.notificationContainer ??
            (typeof document !== 'undefined' ? document.getElementById('notification-container') : null);
        if (!container) return;
        const orphanLoaders = container.querySelectorAll(
            '.orbit-container, .orbit-dot, .loading-container, [data-loader="orbit"]'
        );
        orphanLoaders.forEach((node) => node.remove());
    }

    /**
     * Displays a toast notification.
     * @param {string} message - The message to display in the toast.
     * @param {string} [type='info'] - The type of notification ('info', 'success', 'warning', 'error').
     * @param {number} [duration=6000] - Duration in milliseconds before the toast disappears.
     * @param {string|null} [kind=null] - Optional category tag. A teaching toast the user deliberately
     *   closes is muted for that whole kind from then on (e.g. 'midi-learn'); see toastBridge.
     */
    showToast(message, type = 'info', duration = 6000, kind = null) {
        // The user muted this kind of toast before (closed one deliberately) — drop it silently.
        if (kind && isToastKindSuppressed(kind)) return;

        // Sweep any orphaned boot-loader fragments regardless of render path (cheap, idempotent).
        this.clearTransientLoaders();

        // Tier-1 migration: when the React shell is mounted, render through the design-lib <Toaster>
        // (sonner) instead of the legacy DOM toast. One owner; the legacy path below stays only for
        // the non-React UI and is removed at the go-live gate (cleanup-ledger).
        const sink = getToastSink();
        if (sink) {
            sink(message, type, { duration, kind: kind ?? undefined });
            return;
        }

        // Create the toast element
        const toast = document.createElement('div');
        toast.className = `notification-toast notification-toast-${type}`;
        const messageSpan = document.createElement('span');
        messageSpan.className = 'notification-toast-message';
        messageSpan.textContent = message;
        toast.appendChild(messageSpan);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'notification-toast-close';
        closeButton.setAttribute('aria-label', getT()('common.close'));
        closeButton.textContent = '×';
        toast.appendChild(closeButton);
    
        // Append the toast to the notification container (created on first use; a toast fired
        // before any document/body exists is dropped — there is nowhere to render it).
        const container = this.getContainer();
        if (!container) return;
        container.appendChild(toast);

        const removeToast = () => {
            if (toast.parentNode === container) {
                toast.classList.add('fade-out');
                setTimeout(() => {
                    if (toast.parentNode === container) {
                        container.removeChild(toast);
                    }
                }, 300); // Match the fade-out animation duration
            }
        };

        closeButton.addEventListener('click', () => {
            // Deliberate close of a kinded teaching toast mutes that kind (parity with the sonner path).
            if (kind) suppressToastKind(kind);
            clearTimeout(timeoutId);
            removeToast();
        });

        // Set a timeout to remove the toast after the specified duration
        const timeoutId = setTimeout(removeToast, duration);
    }

    /**
     * Displays a universal modal using ui-core and returns a promise that resolves when the modal is closed.
     * @param {string} title - The title of the modal.
     * @param {string|HTMLElement} content - The content of the modal.
     * @param {string} [buttonText] - The text for the primary button.
     * @returns {Promise<void>} - Resolves when the modal is closed.
     */
    showUniversalModal(title, content, buttonText = null) {
        return new Promise((resolve) => {
            const modalElement = document.getElementById('universalModal');
            const uiCoreNs = getUiCoreNamespace();
            if (!modalElement) {
                console.error('AppNotifications: Universal Modal element not found.');
                resolve();
                return;
            }
            if (!uiCoreNs?.Modal) {
                console.error('AppNotifications: ui-core modal API unavailable.');
                resolve();
                return;
            }

            const t = getT();
            const resolvedButtonText =
                typeof buttonText === 'string' && buttonText.length
                    ? buttonText
                    : t('common.close');
    
            // Update modal title
            const modalTitle = modalElement.querySelector('.modal-title');
            modalTitle.textContent = title;
    
            // Update modal body
            const modalBody = modalElement.querySelector('.modal-body .modal-content-wrapper');
            modalBody.innerHTML = ''; // Clear any existing content
            if (typeof content === 'string') {
                modalBody.innerHTML = content; // Add string content as HTML
            } else if (content instanceof HTMLElement) {
                modalBody.appendChild(content); // Append HTMLElement content
            }
    
            // Update footer button text
            const modalFooterButton = modalElement.querySelector('.modal-footer button');
            modalFooterButton.textContent = resolvedButtonText;
    
            // Add button click event handler
            const buttonHandler = () => {
                modalFooterButton.removeEventListener('click', buttonHandler);
                const modalInstance = uiCoreNs.Modal.getInstance(modalElement);
                if (modalInstance) {
                    modalInstance.hide(); // Close the modal
                }
                resolve();
            };
            modalFooterButton.addEventListener('click', buttonHandler);
    
            // Initialize and show the modal
            const modalInstance = new uiCoreNs.Modal(modalElement, {
                backdrop: true, // Allow clicking outside to close
                keyboard: true  // Allow ESC key to close
            });
            modalInstance.show();
    
            // Cleanup after modal is hidden
            const hiddenHandler = () => {
                modalElement.removeEventListener('hidden.ui-core.modal', hiddenHandler);
                // Remove lingering backdrops if any
                document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
                    backdrop.remove();
                });
                document.body.classList.remove('modal-open');
                document.body.style.overflow = ''; // Restore body scroll behavior
                resolve();
            };
            modalElement.addEventListener('hidden.ui-core.modal', hiddenHandler, { once: true });
    
        });
    }
    closeModal() {
        const modalElement = document.getElementById('universalModal');
        const uiCoreNs = getUiCoreNamespace();
        if (modalElement) {
            // Retrieve the ui-core modal instance
            const modalInstance = uiCoreNs?.Modal?.getInstance(modalElement);
            if (modalInstance) {
                modalInstance.hide(); // Hide the modal
                modalElement.addEventListener('hidden.ui-core.modal', () => {
                    modalInstance.dispose(); // Dispose the modal only after it's fully hidden
    
                    // Clear the modal content to avoid lingering references
                    const modalBody = modalElement.querySelector('.modal-body .modal-content-wrapper');
                    if (modalBody) {
                        modalBody.innerHTML = ''; // Clear the content
                    }
    
                    // Remove lingering backdrops
                    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
                        backdrop.remove();
                    });
    
                    // Reset body scroll behavior
                    document.body.classList.remove('modal-open');
                    document.body.style.overflow = '';
                }, { once: true }); // Attach event handler to fire only once
            } else {
                console.warn('No active modal instance found.');
            }
        } else {
            console.warn('Modal element not found or already closed.');
        }
    }

    /**
     * Displays a Parameter Selection Modal with a list of available parameters.
     * @param {string[]} availableParams - List of available parameters.
     * @returns {Promise<string|null>} - Resolves with the selected parameter or null if canceled.
     */
    showParameterSelectionModal(availableParams) {
        return new Promise((resolve) => {
            // Retrieve the parameter selection modal and its components by their IDs
            const modal = document.getElementById('parameterSelectionModal');
            const parameterList = document.getElementById('parameterList');
            const modalTitle = modal?.querySelector('.modal-title');
            const uiCoreNs = getUiCoreNamespace();
        
            if (!modal || !parameterList || !modalTitle || !uiCoreNs?.Modal) {
                console.error('AppNotifications: Parameter Selection Modal structure is incorrect.');
                resolve(null);
                return;
            }
        
            // Clear any existing list items
            parameterList.innerHTML = '';
        
            // Populate the list with available parameters
            availableParams.forEach(param => {
                const listItem = document.createElement('li');
                listItem.classList.add('list-group-item', 'list-group-item-action');
                listItem.textContent = param;

                // Define the click handler for each list item
                listItem.addEventListener('click', () => {
                    modalTitle.textContent = `Mapping MIDI to '${param}'`;
                    const uiCoreModal = getUiCoreNamespace()?.Modal?.getInstance(modal);
                    if (uiCoreModal) {
                        uiCoreModal.hide();
                    }
                    resolve(param);
                });

                // Append the list item to the parameter list
                parameterList.appendChild(listItem);
            });
        
            // Initialize and show the parameter selection modal using ui-core
            const uiCoreModal = new uiCoreNs.Modal(modal, {
                backdrop: true,
                keyboard: true
            });
            uiCoreModal.show();
        
            // Handle modal dismissal (e.g., clicking outside or pressing ESC)
            modal.addEventListener('hidden.ui-core.modal', () => {
                resolve(null);
            }, { once: true });
        });
    }
}

// Instantiate and export a single instance of AppNotifications
const notifications = new AppNotifications();
export default notifications;
