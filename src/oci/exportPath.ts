/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    AzureWizard,
    AzureWizardExecuteStep,
    AzureWizardPromptStep,
    IActionContext,
    IAzureQuickPickItem,
} from '@microsoft/vscode-azext-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { configPrefix } from '../constants';

const EXPORT_PATH_SETTING = 'oci.exportPath';

interface ExportPathWizardContext extends IActionContext {
    // True if the user chose the OS temp folder; false if they chose a specific folder.
    useTempDir?: boolean;

    // The chosen directory; empty string means "use the OS temp folder".
    chosenDir?: string;

    // Where to persist the chosen value. `'none'` means don't save.
    persistenceTarget?: vscode.ConfigurationTarget | 'none';
}

type ExportTarget = 'temp' | 'choose';

class ChooseExportTargetPromptStep extends AzureWizardPromptStep<ExportPathWizardContext> {
    public async prompt(wizardContext: ExportPathWizardContext): Promise<void> {
        const picks: IAzureQuickPickItem<ExportTarget>[] = [
            { label: vscode.l10n.t('Use temporary folder'), description: os.tmpdir(), data: 'temp' },
            { label: vscode.l10n.t('Choose folder...'), data: 'choose' },
        ];

        const response = await wizardContext.ui.showQuickPick(picks, {
            placeHolder: vscode.l10n.t('Where should exported OCI layouts be saved?'),
        });

        wizardContext.useTempDir = response.data === 'temp';
        if (wizardContext.useTempDir) {
            wizardContext.chosenDir = '';
        }
    }

    public shouldPrompt(wizardContext: ExportPathWizardContext): boolean {
        return wizardContext.useTempDir === undefined;
    }
}

class ChooseFolderPromptStep extends AzureWizardPromptStep<ExportPathWizardContext> {
    public async prompt(wizardContext: ExportPathWizardContext): Promise<void> {
        const selected = await wizardContext.ui.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: vscode.l10n.t('Select Export Folder'),
        });

        wizardContext.chosenDir = selected[0].fsPath;
    }

    public shouldPrompt(wizardContext: ExportPathWizardContext): boolean {
        return !wizardContext.useTempDir && wizardContext.chosenDir === undefined;
    }
}

class ChoosePersistenceTargetPromptStep extends AzureWizardPromptStep<ExportPathWizardContext> {
    public async prompt(wizardContext: ExportPathWizardContext): Promise<void> {
        const picks: IAzureQuickPickItem<vscode.ConfigurationTarget | 'none'>[] = [
            { label: vscode.l10n.t("Don't save"), description: vscode.l10n.t('Ask again next time'), data: 'none' },
            { label: vscode.l10n.t('This workspace'), description: vscode.l10n.t('Save in workspace settings'), data: vscode.ConfigurationTarget.Workspace },
            { label: vscode.l10n.t('All workspaces (user settings)'), description: vscode.l10n.t('Save in user settings'), data: vscode.ConfigurationTarget.Global },
        ];

        const response = await wizardContext.ui.showQuickPick(picks, {
            placeHolder: vscode.l10n.t('Remember this choice?'),
        });

        wizardContext.persistenceTarget = response.data;
    }

    public shouldPrompt(wizardContext: ExportPathWizardContext): boolean {
        return wizardContext.persistenceTarget === undefined;
    }
}

class SaveExportPathSettingStep extends AzureWizardExecuteStep<ExportPathWizardContext> {
    public priority: number = 100;

    public async execute(wizardContext: ExportPathWizardContext): Promise<void> {
        await vscode.workspace
            .getConfiguration(configPrefix)
            .update(EXPORT_PATH_SETTING, wizardContext.chosenDir ?? '', wizardContext.persistenceTarget as vscode.ConfigurationTarget);
    }

    public shouldExecute(wizardContext: ExportPathWizardContext): boolean {
        return wizardContext.persistenceTarget !== undefined && wizardContext.persistenceTarget !== 'none';
    }
}

class OfferGitignoreStep extends AzureWizardExecuteStep<ExportPathWizardContext> {
    public priority: number = 200;

    public async execute(wizardContext: ExportPathWizardContext): Promise<void> {
        const exportDir = wizardContext.chosenDir;
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!exportDir || !workspaceFolders) {
            return;
        }

        for (const folder of workspaceFolders) {
            const rootPath = folder.uri.fsPath;
            const relativePath = path.relative(rootPath, exportDir);

            if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                continue;
            }

            const gitignorePath = path.join(rootPath, '.gitignore');

            if (!fs.existsSync(gitignorePath)) {
                continue;
            }

            const entry = `/${relativePath.replace(/\\/g, '/')}/`;
            const content = fs.readFileSync(gitignorePath, 'utf8');

            if (content.includes(entry) || content.includes(entry.slice(0, -1))) {
                return;
            }

            const yes = vscode.l10n.t('Yes');
            const answer = await vscode.window.showInformationMessage(
                vscode.l10n.t('Add {0} to .gitignore?', entry),
                yes,
                vscode.l10n.t('No')
            );

            if (answer === yes) {
                const newline = content.endsWith('\n') ? '' : '\n';
                fs.appendFileSync(gitignorePath, `${newline}${entry}\n`);
            }

            return;
        }
    }

    public shouldExecute(wizardContext: ExportPathWizardContext): boolean {
        return wizardContext.useTempDir === false && !!wizardContext.chosenDir;
    }
}

export async function resolveExportDir(context: IActionContext): Promise<string> {
    const config = vscode.workspace.getConfiguration(configPrefix);
    const inspect = config.inspect<string>(EXPORT_PATH_SETTING);

    const hasExplicitSetting = Boolean(
        inspect &&
            (inspect.workspaceValue !== undefined ||
                inspect.workspaceFolderValue !== undefined ||
                inspect.globalValue !== undefined)
    );

    if (hasExplicitSetting) {
        return config.get<string>(EXPORT_PATH_SETTING, '');
    }

    const wizardContext = context as ExportPathWizardContext;

    const wizard = new AzureWizard<ExportPathWizardContext>(wizardContext, {
        title: vscode.l10n.t('Configure OCI Layout Export Folder'),
        promptSteps: [
            new ChooseExportTargetPromptStep(),
            new ChooseFolderPromptStep(),
            new ChoosePersistenceTargetPromptStep(),
        ],
        executeSteps: [
            new SaveExportPathSettingStep(),
            new OfferGitignoreStep(),
        ],
    });

    await wizard.prompt();
    await wizard.execute();

    return wizardContext.chosenDir ?? '';
}
