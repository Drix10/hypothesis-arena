/// <reference types="react" />
/// <reference types="react-dom" />

declare namespace JSX {
    interface IntrinsicElements {
        'iconify-icon': React.DetailedHTMLProps<
            React.HTMLAttributes<HTMLElement>,
            HTMLElement
        > & {
            icon?: string;
            width?: string | number;
            height?: string | number;
            class?: string;
            className?: string;
        };
    }
}
