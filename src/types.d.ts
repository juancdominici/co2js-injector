declare module '@tgwf/co2' {
    export class co2 {
        constructor(options?: { model?: string });
        perByte(bytes: number, green?: boolean): number;
    }
}

// Minimal declaration so TypeScript accepts the global fetch in Node 20.
declare function fetch(input: any, init?: any): Promise<any>;