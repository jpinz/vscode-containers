/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActionContext } from '@microsoft/vscode-azext-utils';
import { IContainersClient, parseDockerLikeImageName, PodmanClient, VoidCommandResponse } from '@microsoft/vscode-container-client';
import { CommandLineArgs, composeArgs, withArg, withNamedArg } from '@microsoft/vscode-processutils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ext } from '../extensionVariables';
import { TaskCommandRunnerFactory } from '../runtimes/runners/TaskCommandRunnerFactory';
import { OCI_METADATA_FILENAME, ORAS_COMMAND } from './constants';
import { resolveExportDir } from './exportPath';

interface ExportMetadata {
    reference: string;
    exportedAt: string;
    source: 'docker-daemon' | 'registry';
    tool: 'oras' | 'podman-save';
}

function isPodman(client: IContainersClient): boolean {
    return client.id === PodmanClient.ClientId;
}

interface ExportImageOptions {
    source?: 'docker-daemon' | 'registry';
}

function writeExportMetadata(
    outputDir: string,
    reference: string,
    source: ExportMetadata['source'],
    tool: ExportMetadata['tool']
): void {
    const metadata: ExportMetadata = {
        reference,
        exportedAt: new Date().toISOString(),
        source,
        tool,
    };

    fs.writeFileSync(path.join(outputDir, OCI_METADATA_FILENAME), JSON.stringify(metadata, null, 2));
}

function sanitizeImageName(reference: string): string {
    return reference
        .replace(/[/:@]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

function asTaggedLayoutRef(layoutPath: string, tag: string): string {
    return `${layoutPath}:${tag}`;
}

function toNormalizedRegistryReference(reference: string): string {
    const info = parseDockerLikeImageName(reference);

    if (!info.image) {
        throw new Error(vscode.l10n.t('Invalid image reference: {0}', reference));
    }

    const registry = info.registry || 'docker.io';
    // docker.io implicitly places top-level images under the `library` namespace.
    const imagePath =
        registry === 'docker.io' && !info.image.includes('/')
            ? `library/${info.image}`
            : info.image;

    let suffix = '';
    if (info.tag) {
        suffix += `:${info.tag}`;
    }
    if (info.digest) {
        suffix += `@${info.digest}`;
    }

    return `${registry}/${imagePath}${suffix}`;
}

async function resolveLocalImagePlatform(reference: string): Promise<string | null> {
    try {
        const inspectResults = await ext.runWithDefaults((client) =>
            client.inspectImages({ imageRefs: [reference] })
        );

        const result = inspectResults[0];
        if (!result?.operatingSystem || !result?.architecture) {
            return null;
        }

        return `${result.operatingSystem}/${result.architecture}`;
    } catch {
        return null;
    }
}

async function runTask(command: string, args: CommandLineArgs, taskName: string): Promise<void> {
    const runner = new TaskCommandRunnerFactory({
        taskName,
        alwaysRunNew: true,
        rejectOnError: true,
        focus: false,
    });

    const response: VoidCommandResponse = { command, args };
    await runner.getCommandRunner()(response);
}

async function dockerSaveToTar(
    containerCommandName: string,
    reference: string,
    tarPath: string,
    platform?: string
): Promise<void> {
    const args = composeArgs(
        withArg('save'),
        withNamedArg('--platform', platform),
        withArg(reference),
        withNamedArg('-o', tarPath),
    )();

    await runTask(
        containerCommandName,
        args,
        vscode.l10n.t('Save {0} as OCI archive', reference)
    );
}

async function podmanSaveToOciLayout(
    podmanCommandName: string,
    reference: string,
    outputDir: string
): Promise<void> {
    // Podman can write an OCI layout directly, but it doesn't create the output directory if it doesn't exist, so ensure it exists first.
    fs.mkdirSync(outputDir, { recursive: true });

    const args = composeArgs(
        withArg('save'),
        withNamedArg('--format', 'oci-dir'),
        withNamedArg('--output', outputDir),
        withArg(reference),
    )();

    await runTask(
        podmanCommandName,
        args,
        vscode.l10n.t('Save {0} as OCI layout', reference)
    );
}

async function podmanPull(podmanCommandName: string, reference: string): Promise<void> {
    const args = composeArgs(
        withArg('pull'),
        withArg(reference),
    )();

    await runTask(
        podmanCommandName,
        args,
        vscode.l10n.t('Pull {0}', reference)
    );
}

async function convertArchiveToOciLayout(
    archivePath: string,
    outputDir: string,
    sourceTag: string,
    destinationTag: string
): Promise<void> {
    const args = composeArgs(
        withArg('cp', '--recursive'),
        withNamedArg('--from-oci-layout', asTaggedLayoutRef(archivePath, sourceTag)),
        withNamedArg('--to-oci-layout', asTaggedLayoutRef(outputDir, destinationTag)),
    )();

    await runTask(
        ORAS_COMMAND,
        args,
        vscode.l10n.t('Convert archive to OCI layout')
    );
}

async function orasCopyFromRegistry(reference: string, outputDir: string): Promise<void> {
    fs.mkdirSync(outputDir, { recursive: true });

    const registryReference = toNormalizedRegistryReference(reference);
    if (registryReference !== reference) {
        ext.outputChannel.info(
            vscode.l10n.t('Normalized registry reference: {0} -> {1}', reference, registryReference)
        );
    }

    const destinationTag = parseDockerLikeImageName(registryReference).tag ?? 'latest';

    const args = composeArgs(
        withArg('cp', '--recursive'),
        withArg(registryReference),
        withNamedArg('--to-oci-layout', asTaggedLayoutRef(outputDir, destinationTag)),
    )();

    await runTask(
        ORAS_COMMAND,
        args,
        vscode.l10n.t('Copy {0} to OCI layout', registryReference)
    );
}

async function dockerSaveAndConvert(
    client: IContainersClient,
    reference: string,
    outputDir: string,
    persistentTarPath?: string
): Promise<void> {
    fs.mkdirSync(outputDir, { recursive: true });

    let tarPath: string;
    let tempDir: string | undefined;

    if (persistentTarPath) {
        tarPath = persistentTarPath;
        fs.mkdirSync(path.dirname(tarPath), { recursive: true });
        if (fs.existsSync(tarPath)) {
            fs.rmSync(tarPath, { force: true });
        }
    } else {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-export-'));
        tarPath = path.join(tempDir, 'image.tar');
    }

    try {
        const referenceTag = parseDockerLikeImageName(reference).tag ?? 'latest';

        await dockerSaveToTar(client.commandName, reference, tarPath);

        try {
            await convertArchiveToOciLayout(tarPath, outputDir, referenceTag, referenceTag);
        } catch (error) {
            const localPlatform = await resolveLocalImagePlatform(reference);
            if (!localPlatform) {
                throw error;
            }

            ext.outputChannel.warn(
                vscode.l10n.t(
                    'Multi-platform conversion failed; retrying with concrete platform {0}...',
                    localPlatform
                )
            );

            await dockerSaveToTar(client.commandName, reference, tarPath, localPlatform);
            await convertArchiveToOciLayout(tarPath, outputDir, referenceTag, referenceTag);
        }
    } finally {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
}

async function exportFromDaemon(
    client: IContainersClient,
    reference: string,
    outputDir: string,
    source: ExportMetadata['source'],
    persistentTarPath?: string
): Promise<void> {
    if (isPodman(client)) {
        // Podman writes an OCI image layout directly from its local store.
        await podmanSaveToOciLayout(client.commandName, reference, outputDir);
        writeExportMetadata(outputDir, reference, source, 'podman-save');
        return;
    }

    try {
        await dockerSaveAndConvert(client, reference, outputDir, persistentTarPath);
        writeExportMetadata(outputDir, reference, source, ORAS_COMMAND);
        return;
    } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError);
        ext.outputChannel.warn(
            vscode.l10n.t(
                'docker save / oras conversion failed ({0}); falling back to pulling {1} from its registry\u2026',
                message,
                reference
            )
        );
    }

    // Clear any partial output from the failed docker-save attempt before
    // retrying via the registry; if the registry also can't serve the
    // reference, orasCopyFromRegistry throws and the export fails.
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }

    await orasCopyFromRegistry(reference, outputDir);
    writeExportMetadata(outputDir, reference, source, ORAS_COMMAND);
}

async function exportFromRegistry(
    client: IContainersClient,
    reference: string,
    outputDir: string
): Promise<void> {
    if (isPodman(client)) {
        // Podman has no direct "registry -> oci layout" path, so pull into the
        // local store and then save. The image is left behind in Podman's store.
        await podmanPull(client.commandName, reference);
        await podmanSaveToOciLayout(client.commandName, reference, outputDir);
        writeExportMetadata(outputDir, reference, 'registry', 'podman-save');
        return;
    }

    await orasCopyFromRegistry(reference, outputDir);
    writeExportMetadata(outputDir, reference, 'registry', ORAS_COMMAND);
}

export async function exportImageToOciLayout(
    context: IActionContext,
    reference: string,
    options?: ExportImageOptions
): Promise<string> {
    const source = options?.source ?? 'docker-daemon';
    const configuredDir = await resolveExportDir(context);
    const imageDirName = sanitizeImageName(reference);

    const outputDir = configuredDir
        ? path.join(configuredDir, imageDirName)
        : path.join(os.tmpdir(), 'oci-layouts', imageDirName);

    if (fs.existsSync(outputDir)) {
        ext.outputChannel.info(
            vscode.l10n.t('Replacing existing OCI layout directory: {0}', outputDir)
        );
        fs.rmSync(outputDir, { recursive: true, force: true });
    }

    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    ext.outputChannel.info(vscode.l10n.t('Preparing OCI layout directory: {0}', outputDir));

    const client = await ext.runtimeManager.getClient();

    if (source === 'registry') {
        await exportFromRegistry(client, reference, outputDir);
    } else {
        const persistentTarPath = configuredDir
            ? path.join(configuredDir, `${imageDirName}.tar`)
            : undefined;
        await exportFromDaemon(client, reference, outputDir, source, persistentTarPath);
    }

    return outputDir;
}
