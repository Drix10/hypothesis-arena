/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';

declare global {
    namespace JSX {
        interface IntrinsicElements {
            'iconify-icon': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
                icon?: string;
                width?: string | number;
                height?: string | number;
                class?: string;
                className?: string;
            };
        }
    }
}

export { };
