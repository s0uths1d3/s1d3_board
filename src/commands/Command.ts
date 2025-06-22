export interface Command {
    execute(event?: { state: string }): Promise<void>;
}