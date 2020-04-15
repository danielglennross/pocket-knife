import * as R from 'ramda';

type Registration = {
  name: string;
  tag: string;
  resolver: Resolver<any>;
};

type Resolver<T> = (context: ContainerContext) => T;

type RegistrationResolver = (registrationFunc: Resolver<any>) => any;

type LifetimeCreator = {
  factory: RegistrationResolver;
  single: RegistrationResolver;
};

type RegistrationDependency = {
  name: string;
  parent: RegistrationDependency;
};

export type RegistrationOption = {
  lifetime?: 'single' | 'factory';
  tag?: string;
};

export type ResolverFuncOptions = {
  lazy?: boolean;
};

export type ContainerContext = {
  resolve: <U = any>(
    dependencyName: string,
    options?: ResolverFuncOptions,
  ) => U;
  resolveTagged: (tagName: string) => any;
};

export class Container {
  private registrations: Registration[];
  private lifetimeCreator: LifetimeCreator;

  constructor() {
    this.registrations = [];
    this.lifetimeCreator = {
      factory: registrationFunc => (context: ContainerContext) =>
        registrationFunc(context),
      single: registrationFunc => {
        let cachedInstance = null;
        return (context: ContainerContext) => {
          return cachedInstance || (cachedInstance = registrationFunc(context));
        };
      },
    };
  }

  register<T>(
    name: string,
    registration: Resolver<T>,
    { lifetime = 'factory', tag = null }: RegistrationOption = {},
  ) {
    if (!name) {
      throw new Error('registration must provide a name');
    }
    if (!(registration && registration instanceof Function)) {
      throw new Error('registration must be a function');
    }
    if (!lifetime.match(/factory|single/)) {
      throw new Error('lifetime must be either `factory` or `single`');
    }

    // replace a duplicate registration with latest
    this.registrations = R.unionWith(
      R.eqBy(R.prop('name')),
      [
        {
          name,
          tag,
          resolver: this.lifetimeCreator[lifetime](registration),
        },
      ],
      this.registrations,
    );
  }

  resolve<T>(name: string): T {
    const find = (lookup: string) => {
      const reg = this.registrations.find(r => r.name === lookup);
      if (!reg) {
        throw new Error(`cannot find registration for name ${lookup}`);
      }
      return reg;
    };

    const dependency = <U = any>(
      parent: RegistrationDependency,
      dependencyName: string,
      { lazy = false }: ResolverFuncOptions = {},
    ): U | (() => U) => {
      const dependencyType = <RegistrationDependency>{
        name: dependencyName,
        parent,
      };

      const context: ContainerContext = {
        resolve: dependency.bind(this, dependencyType),
        resolveTagged: tagName => this.resolveTag(tagName),
      };

      // if lazy, we'll return the resolver as a factory, to be invoken when needed
      // this means, we don't have to check for circular dependencies
      if (lazy) {
        const reg = find(dependencyName);
        return () => <U>reg.resolver(context);
      }

      const hasCircularDependency = (
        currentParentType: RegistrationDependency,
      ) => {
        if (currentParentType === null) return false;
        if (currentParentType.name === dependencyName) return true;
        return hasCircularDependency(currentParentType.parent);
      };

      if (hasCircularDependency(dependencyType.parent)) {
        throw new Error(
          `${name} registration has a circular dependency on ${dependencyType.parent.name}`,
        );
      }

      const reg = find(dependencyName);
      return <U>reg.resolver(context);
    };

    const context: ContainerContext = {
      resolve: dependency.bind(this, { name, parent: null }),
      resolveTagged: tagName => this.resolveTag(tagName),
    };

    const reg = find(name);
    return <T>reg.resolver(context);
  }

  resolveTag(tag: string): { [key in string]: any } {
    const taggedRegs = this.registrations.filter(r => r.tag === tag);
    if (!taggedRegs.length) {
      throw new Error(`cannot find registrations for tag ${tag}`);
    }
    return taggedRegs.reduce(
      (acc, reg) => ({
        ...acc,
        [reg.name]: this.resolve(reg.name),
      }),
      {},
    );
  }
}
