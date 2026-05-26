/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { configPrefix } from '../constants';

export const OCI_BLOB_SCHEME = 'containers-oci';

const DEFAULT_JSON_DETECTION_MAX_SIZE_MB = 8;
const JSON_DETECTION_MAX_SIZE_MB_SETTING = 'oci.jsonDetectionMaxSizeMB';
const BYTES_PER_MB = 1024 * 1024;
// Absolute cap on how much we'll read into memory for the virtual document,
// regardless of the configured JSON-handling threshold.
const MAX_CONTENT_BYTES = 50 * BYTES_PER_MB;

export function getJsonDetectionMaxBytes(): number {
    const configured = vscode.workspace
        .getConfiguration(configPrefix)
        .get<number>(JSON_DETECTION_MAX_SIZE_MB_SETTING, DEFAULT_JSON_DETECTION_MAX_SIZE_MB);

    const sizeMb =
        typeof configured === 'number' && Number.isFinite(configured) && configured > 0
            ? configured
            : DEFAULT_JSON_DETECTION_MAX_SIZE_MB;

    return Math.floor(sizeMb * BYTES_PER_MB);
}

// Wraps an OCI blob file path in a custom URI so it opens as a read-only,
// pretty-printed virtual document instead of editing the on-disk blob (whose
// digest must match its content byte-for-byte).
export function toOciBlobUri(filePath: string): vscode.Uri {
    return vscode.Uri.file(filePath).with({ scheme: OCI_BLOB_SCHEME });
}

export class OciBlobContentProvider implements vscode.TextDocumentContentProvider {
    public async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        const stat = await fs.stat(uri.fsPath);

        if (stat.size > MAX_CONTENT_BYTES) {
            return vscode.l10n.t(
                'Blob is too large to display ({0} bytes; limit {1} bytes).',
                stat.size,
                MAX_CONTENT_BYTES
            );
        }

        if (token.isCancellationRequested) {
            return '';
        }

        const raw = await fs.readFile(uri.fsPath, 'utf8');

        if (token.isCancellationRequested || stat.size > getJsonDetectionMaxBytes()) {
            return raw;
        }

        try {
            return JSON.stringify(JSON.parse(raw) as unknown, null, 4);
        } catch {
            return raw;
        }
    }
}
